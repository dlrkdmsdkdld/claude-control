import { execFile } from "child_process";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { configDirLabel } from "./claude-config";
import { type CodexLine, codexPreview, codexTurnState, type CodexTurnState } from "./codex-reader";
import { APPROVAL_SETTLE_MS, PROCESS_TIMEOUT_MS } from "./constants";
import { getGitSummary, getMainWorktreePath, getPrUrl } from "./git-info";
import { repoNameFromPath } from "./paths";
import { decodeLsofName, getBatchWorkingDirectories } from "./process-utils";
import { detectSessionHost, hasToolChild, hostAcceptsTerminalInput } from "./session-host";
import { markRecentlyDone } from "./session-link";
import { getJsonlMtime, readJsonlTail } from "./session-reader";
import { getTtysForPids } from "./terminal/detect";
import type { ProcessTreeEntry } from "./terminal/types";
import type { ClaudeSession, SessionStatus } from "./types";
import { readOpenFolders, resolveWorkspaceForCwd } from "./vscode";

const execFileAsync = promisify(execFile);

/**
 * Codex (OpenAI) sessions. Unlike Claude, one Codex process can host several
 * conversations ("threads"): the VS Code extension and ChatGPT app run one
 * app-server per window, and terminal TUIs share an app-server daemon. The
 * process that has a thread loaded holds <CODEX_HOME>/thread-writer-locks/<id>.lock,
 * which links each thread to a live process; state_*.sqlite has its metadata.
 */

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_TAIL_LINES = 150;

function base(comm: string): string {
  return comm.includes("/") ? comm.split("/").pop() || comm : comm;
}

/** PIDs of Codex CLI / app-server processes (main binary only, not helpers). */
export function findCodexPids(processTree: Map<number, ProcessTreeEntry>): number[] {
  const pids: number[] = [];
  for (const [pid, entry] of processTree) if (base(entry.comm) === "codex") pids.push(pid);
  return pids;
}

/** ~/.codex and ~/.codex-* dirs that contain a thread state database. */
async function listCodexHomes(): Promise<{ home: string; db: string }[]> {
  const root = homedir();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const homes = entries.filter((e) => /^\.codex(-[A-Za-z0-9._-]+)?$/.test(e)).map((e) => join(root, e));
  if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
  const out: { home: string; db: string }[] = [];
  for (const home of new Set(homes)) {
    try {
      const dbs = (await readdir(home)).filter((f) => /^state_\d+\.sqlite$/.test(f));
      if (dbs.length === 0) continue;
      dbs.sort((a, b) => parseInt(b.slice(6), 10) - parseInt(a.slice(6), 10));
      out.push({ home, db: join(home, dbs[0]) });
    } catch {
      // not readable
    }
  }
  return out;
}

/** Parse `lsof -Fpn` output into lock-file thread id → holder PID. */
export function parseLockHolders(lsofOutput: string): Map<string, number> {
  const holders = new Map<string, number>();
  let pid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = parseInt(line.slice(1), 10);
    else if (line.startsWith("n") && pid !== null) {
      const m = basename(decodeLsofName(line.slice(1))).match(/^(.+)\.lock$/);
      if (m && THREAD_ID_RE.test(m[1])) holders.set(m[1], pid);
    }
  }
  return holders;
}

async function lockHolders(home: string): Promise<Map<string, number>> {
  const dir = join(home, "thread-writer-locks");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".lock") && THREAD_ID_RE.test(f.slice(0, -5)));
  } catch {
    return new Map();
  }
  if (files.length === 0) return new Map();
  try {
    const { stdout } = await execFileAsync("lsof", ["-Fpn", "--", ...files.map((f) => join(dir, f))], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    return parseLockHolders(stdout);
  } catch (err) {
    // lsof exits 1 when some files aren't open; its stdout is still valid
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ? parseLockHolders(stdout) : new Map();
  }
}

export interface CodexThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
  source: string;
  originator: string | null;
  git_branch: string | null;
}

/** Read thread rows with the system sqlite3, read-only. Returns [] if the schema doesn't match. */
async function readThreads(db: string, ids: string[]): Promise<CodexThreadRow[]> {
  const safe = ids.filter((id) => THREAD_ID_RE.test(id));
  if (safe.length === 0) return [];
  const sql = `select id, rollout_path, cwd, title, source, originator, git_branch from threads where id in (${safe
    .map((id) => `'${id}'`)
    .join(",")}) and archived = 0`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", db, sql], { timeout: PROCESS_TIMEOUT_MS });
    return stdout.trim() ? (JSON.parse(stdout) as CodexThreadRow[]) : [];
  } catch {
    return [];
  }
}

/** Sub-agent threads are spawned by another thread; they're shown through their parent. */
export function isSubagentThread(row: Pick<CodexThreadRow, "source">): boolean {
  return row.source.trim().startsWith("{");
}

/**
 * The app-server daemon that terminal TUIs share. It is spawned by the first
 * TUI (so it inherits that TUI's ancestry, e.g. an IDE terminal) and lives in
 * <CODEX_HOME>/packages/app-server-daemon. VS Code / ChatGPT app-servers are
 * children of their app, not of another codex process.
 */
export function isAppServerDaemon(pid: number, processTree: Map<number, ProcessTreeEntry>): boolean {
  const entry = processTree.get(pid);
  if (!entry) return false;
  if (entry.comm.includes("/app-server-daemon/")) return true;
  const parent = processTree.get(entry.ppid);
  return parent !== undefined && base(parent.comm) === "codex";
}

/**
 * Terminal TUIs talk to a shared app-server daemon that holds the thread lock,
 * so the TUI is found by working directory. Returns the TUI and whether the
 * match is ambiguous (several TUIs in the same folder).
 */
export function matchTuiForThread(
  threadCwd: string,
  tuis: { pid: number; cwd: string | null }[],
): { pid: number; ambiguous: boolean } | null {
  const want = threadCwd.normalize("NFC");
  const matches = tuis.filter((t) => t.cwd?.normalize("NFC") === want);
  if (matches.length === 0) return null;
  return { pid: matches[0].pid, ambiguous: matches.length > 1 };
}

/**
 * Status from the rollout: in a turn → working, unless a tool call is waiting
 * with no child process running it and the policy can ask for approval, which
 * is reported as waiting (Codex doesn't record approval requests on disk).
 */
export function codexStatus(
  state: CodexTurnState,
  opts: { now: number; toolRunning: (since: number) => boolean },
): SessionStatus {
  if (!state.inTurn) return state.errored ? "errored" : "idle";
  if (state.approvalPolicy === "never" || state.pendingCalls.length === 0) return "working";
  const oldest = state.pendingCalls.reduce<number | null>(
    (acc, c) => (c.at === null ? acc : acc === null ? c.at : Math.min(acc, c.at)),
    null,
  );
  if (oldest === null || opts.now - oldest < APPROVAL_SETTLE_MS) return "working";
  return opts.toolRunning(oldest) ? "working" : "waiting";
}

export async function discoverCodexSessions(processTree: Map<number, ProcessTreeEntry>): Promise<ClaudeSession[]> {
  const codexPids = findCodexPids(processTree);
  if (codexPids.length === 0) return [];
  const codexPidSet = new Set(codexPids);

  const homes = await listCodexHomes();
  const loaded: { row: CodexThreadRow; holder: number; home: string }[] = [];
  await Promise.all(
    homes.map(async ({ home, db }) => {
      const holders = await lockHolders(home);
      const live = Array.from(holders).filter(([, pid]) => codexPidSet.has(pid));
      if (live.length === 0) return;
      const rows = await readThreads(
        db,
        live.map(([id]) => id),
      );
      for (const row of rows) {
        if (isSubagentThread(row)) continue;
        loaded.push({ row, holder: holders.get(row.id)!, home });
      }
    }),
  );
  if (loaded.length === 0) return [];

  // Terminal TUIs: codex processes attached to a TTY
  const ttys = await getTtysForPids(codexPids);
  const tuiPids = codexPids.filter((pid) => ttys.has(pid));
  const tuiCwds = await getBatchWorkingDirectories(tuiPids);
  const tuis = tuiPids.map((pid) => ({ pid, cwd: tuiCwds.get(pid) ?? null }));

  const now = Date.now();
  const sessions = await Promise.all(
    loaded.map(async ({ row, holder, home }) => {
      let pid = holder;
      let inferred = false;
      let host = detectSessionHost(holder, processTree, {
        entrypoint: null,
        hasTty: ttys.has(holder),
        tmuxSession: null,
      });
      // A lock held by the shared app-server daemon belongs to a terminal TUI
      if (!ttys.has(holder) && isAppServerDaemon(holder, processTree)) {
        const tui = matchTuiForThread(row.cwd, tuis);
        if (!tui) return null; // loaded in the daemon but no terminal is showing it
        pid = tui.pid;
        inferred = tui.ambiguous;
        host = detectSessionHost(tui.pid, processTree, { entrypoint: null, hasTty: true, tmuxSession: null });
      }
      return buildCodexSession(row, {
        pid,
        holder,
        host,
        inferred,
        holderHasTty: ttys.has(holder),
        home,
        now,
        processTree,
      });
    }),
  );
  return sessions.filter((s): s is ClaudeSession => s !== null);
}

async function buildCodexSession(
  row: CodexThreadRow,
  ctx: {
    pid: number;
    holder: number;
    host: ClaudeSession["host"];
    inferred: boolean;
    holderHasTty: boolean;
    home: string;
    now: number;
    processTree: Map<number, ProcessTreeEntry>;
  },
): Promise<ClaudeSession> {
  const cwd = row.cwd;
  const [lines, mtime, git, mainWorktreePath] = await Promise.all([
    readJsonlTail(row.rollout_path, ROLLOUT_TAIL_LINES) as Promise<CodexLine[]>,
    getJsonlMtime(row.rollout_path),
    getGitSummary(cwd),
    getMainWorktreePath(cwd),
  ]);

  const state = codexTurnState(lines);
  const preview = codexPreview(lines);
  const status: SessionStatus =
    lines.length === 0
      ? "unknown"
      : markRecentlyDone(
          codexStatus(state, {
            now: ctx.now,
            toolRunning: (since) => hasToolChild(ctx.holder, ctx.processTree, ctx.now - since),
          }),
          { assistantIsNewer: preview.assistantIsNewer, lastActivityMs: mtime?.getTime() ?? null, now: ctx.now },
        );

  const branch = git?.branch ?? row.git_branch ?? null;
  const skipPrLookup = !branch || branch === "main" || branch === "master";
  const prUrl = skipPrLookup ? null : await getPrUrl(cwd, branch);
  const isWorktree = mainWorktreePath !== null && mainWorktreePath !== cwd;

  let editorWorkspace: string | null = null;
  if (ctx.host.kind === "vscode-extension" || ctx.host.kind === "vscode-terminal") {
    editorWorkspace = resolveWorkspaceForCwd(cwd, await readOpenFolders(ctx.host.appName));
  }

  let startedAt: string | null = null;
  try {
    startedAt = (await stat(row.rollout_path)).birthtime.toISOString();
  } catch {
    // keep null
  }

  return {
    id: row.id,
    agent: "codex",
    pid: ctx.pid,
    workingDirectory: cwd,
    repoName: repoNameFromPath(cwd),
    parentRepo: isWorktree ? mainWorktreePath : null,
    isWorktree,
    branch,
    status,
    lastActivity: (mtime ?? new Date(ctx.now)).toISOString(),
    startedAt,
    git,
    preview,
    hasPendingToolUse: false,
    taskSummary: row.title
      ? { title: row.title.slice(0, 120), description: null, source: "prompt", ticketId: null, ticketUrl: null }
      : null,
    jsonlPath: row.rollout_path,
    prUrl,
    orphaned: false,
    tmuxSession: null,
    host: ctx.host,
    entrypoint: row.originator,
    configDir: configDirLabel(ctx.home),
    linkSource: ctx.inferred ? "inferred" : "lock",
    statusSource: lines.length === 0 ? "none" : "transcript",
    editorWorkspace,
    canOpenConversation: false,
    // Host is the TUI's terminal for terminal sessions; app-server hosts (VS Code, ChatGPT app) never accept typed input
    acceptsInput: hostAcceptsTerminalInput(ctx.host),
    // Only a terminal TUI owns its process; app-servers serve every conversation in their window/app
    sharedProcess: ctx.pid === ctx.holder && !ctx.holderHasTty,
  };
}
