import { readdir, stat } from "fs/promises";
import { join } from "path";
import { configDirLabel, findTranscriptForSession, listClaudeConfigDirs, projectDirFor } from "./claude-config";
import { discoverCodexSessions } from "./codex-discovery";
import { type CodexLine, codexLinesToConversation } from "./codex-reader";
import { ORPHAN_CHECK_INTERVAL_MS } from "./constants";
import { getGitDiff, getGitSummary, getMainWorktreePath, getPrUrl } from "./git-info";
import { type HookStatus, readAllHookStatuses } from "./hooks-reader";
import { repoNameFromPath } from "./paths";
import {
  getAllProcessInfos,
  getProcessDetails,
  isAuxiliaryClaudeArgs,
  ProcessDetails,
  ProcessInfo,
  sessionIdFromArgs,
} from "./process-utils";
import { detectSessionHost, hasToolChild, hostAcceptsTerminalInput } from "./session-host";
import {
  chooseSessionId,
  markRecentlyDone,
  pickInferredTranscript,
  resolveStatus,
  TranscriptCandidate,
} from "./session-link";
import { loadSessionMeta } from "./session-meta";
import {
  extractBranch,
  extractPreview,
  extractSessionId,
  extractStartedAt,
  extractTaskSummary,
  getJsonlMtime,
  hasPendingToolUse,
  isAskingForInput,
  isAwaitingAssistant,
  lastMessageHasError,
  pendingToolUseStartedAt,
  linesToConversation,
  readFullConversation,
  readJsonlHead,
  readJsonlTail,
} from "./session-reader";
import { isAuxiliaryKind, type RegistryEntry, readSessionRegistries, selectRegistryEntry } from "./session-registry";
import { classifyStatus } from "./status-classifier";
import {
  buildProcessTree,
  detectAllTmuxPanes,
  detectTmuxClients,
  evictStaleTerminalCache,
  findClaudePidsFromTree,
  getTtysForPids,
  isOrphaned,
} from "./terminal/detect";
import type { ProcessTreeEntry } from "./terminal/types";
import {
  extensionDirFromBinary,
  extensionSupportsOpenSession,
  readOpenFolders,
  resolveWorkspaceForCwd,
} from "./vscode";
import { ClaudeSession, ConversationPreview, SessionDetail, TranscriptLinkSource } from "./types";

async function listTranscripts(projectDir: string): Promise<TranscriptCandidate[]> {
  try {
    const entries = await readdir(projectDir);
    const out: TranscriptCandidate[] = [];
    await Promise.all(
      entries
        .filter((e) => e.endsWith(".jsonl"))
        .map(async (f) => {
          const fullPath = join(projectDir, f);
          try {
            out.push({ path: fullPath, mtimeMs: (await stat(fullPath)).mtimeMs });
          } catch {
            // skip
          }
        }),
    );
    return out;
  } catch {
    return [];
  }
}

// Orphan check runs on a slower cadence than the main poll
let lastOrphanCheck = 0;
let orphanedPids = new Set<number>();
let pidTmuxSession = new Map<number, string>();
let pidHasTty = new Map<number, boolean>();

/** Transcript writes this much newer than the registry's last update mean its status is stale. */
const REGISTRY_STALE_MS = 3000;
/** A prompt left unanswered longer than this is not treated as an in-progress turn. */
const AWAITING_REPLY_MAX_MS = 5 * 60 * 1000;

/** Sessions whose process exited recently — kept briefly so the card shows "Finished". */
const FINISHED_RETENTION_MS = 2 * 60 * 1000;
/** Keyed by `${id}-${pid}`: one Codex process can host several conversations. */
let previousSessions = new Map<string, ClaudeSession>();
const recentlyFinished = new Map<string, { session: ClaudeSession; endedAt: number }>();

interface LinkResult {
  sessionId: string | null;
  jsonlPath: string | null;
  source: TranscriptLinkSource | null;
}

interface SessionContext {
  info: ProcessInfo & { workingDirectory: string };
  details: ProcessDetails | undefined;
  registry: RegistryEntry | null;
  hook: HookStatus | undefined;
  configDirs: string[];
}

/** Link a process to its conversation using only verifiable evidence. */
async function linkTranscript(ctx: SessionContext): Promise<LinkResult> {
  const chosen = chooseSessionId({
    registry: ctx.registry,
    hook: ctx.hook,
    argsSessionId: ctx.details ? sessionIdFromArgs(ctx.details.args) : null,
  });
  if (!chosen) return { sessionId: null, jsonlPath: null, source: null };

  if (chosen.source === "hook" && ctx.hook?.transcriptPath) {
    return { sessionId: chosen.sessionId, jsonlPath: ctx.hook.transcriptPath, source: "hook" };
  }
  const jsonlPath = await findTranscriptForSession(ctx.configDirs, ctx.info.workingDirectory, chosen.sessionId);
  // A known session ID without a transcript is a fresh conversation with no messages yet
  return { sessionId: chosen.sessionId, jsonlPath, source: chosen.source };
}

async function buildSession(
  ctx: SessionContext,
  link: LinkResult,
  processTree: Map<number, ProcessTreeEntry>,
  orphaned: boolean,
  tmuxSession: string | null,
): Promise<ClaudeSession> {
  const { info, registry, details } = ctx;
  const jsonlPath = link.jsonlPath;

  let sessionId = link.sessionId ?? `pid-${info.pid}`;
  let startedAt: string | null = null;
  let branch: string | null = null;
  let preview: ConversationPreview = {
    lastUserMessage: null,
    lastAssistantText: null,
    assistantIsNewer: false,
    lastTools: [],
    messageCount: 0,
  };
  let hasError = false;
  let askingForInput = false;
  let pendingToolUse = false;
  let awaitingAssistant = false;
  let toolUseStartedAt: number | null = null;
  let mtime: Date | null = null;
  let lastActivity = registry?.updatedAt ? new Date(registry.updatedAt).toISOString() : new Date().toISOString();
  let taskSummary: ClaudeSession["taskSummary"] = null;

  const [jsonlResult, git, mainWorktreePath] = await Promise.all([
    jsonlPath
      ? Promise.all([readJsonlTail(jsonlPath), readJsonlHead(jsonlPath), getJsonlMtime(jsonlPath)])
      : Promise.resolve(null),
    getGitSummary(info.workingDirectory),
    getMainWorktreePath(info.workingDirectory),
  ]);

  if (jsonlResult) {
    const [lines, headLines, jsonlMtime] = jsonlResult;
    mtime = jsonlMtime;
    if (!link.sessionId) sessionId = extractSessionId(lines) ?? sessionId;
    startedAt = extractStartedAt(lines);
    branch = extractBranch(lines);
    preview = extractPreview(lines);
    hasError = lastMessageHasError(lines);
    askingForInput = isAskingForInput(lines);
    pendingToolUse = hasPendingToolUse(lines);
    awaitingAssistant = isAwaitingAssistant(lines);
    toolUseStartedAt = pendingToolUseStartedAt(lines);
    taskSummary = extractTaskSummary(headLines);
    if (mtime) lastActivity = mtime.toISOString();
  }

  const resolvedBranch = git?.branch ?? branch;
  const skipPrLookup = !resolvedBranch || resolvedBranch === "main" || resolvedBranch === "master";
  const prUrl = skipPrLookup ? null : await getPrUrl(info.workingDirectory, resolvedBranch);

  const isWorktree = mainWorktreePath !== null && mainWorktreePath !== info.workingDirectory;
  const parentRepo = isWorktree ? mainWorktreePath : null;

  // Registry status is written by the CLI itself (busy/idle/waiting) and is
  // authoritative. Hooks come next; the transcript heuristic is the fallback.
  // PermissionRequest hooks are ignored (they fire for auto-approved tools too).
  // The registry only changes on status transitions, so transcript writes after
  // a "busy" update are normal. An idle/waiting status older than the latest
  // transcript write means this CLI stopped refreshing it.
  const registryStale =
    registry?.updatedAt != null &&
    registry.status !== "busy" &&
    registry.status !== "shell" &&
    mtime !== null &&
    mtime.getTime() - registry.updatedAt > REGISTRY_STALE_MS;
  // A tool (Bash etc.) is executing in a child process started after the pending tool_use
  // (progress lines keep the transcript fresh, so its mtime can't be the reference)
  const runningTool = toolUseStartedAt !== null && hasToolChild(info.pid, processTree, Date.now() - toolUseStartedAt);
  const recentlyAwaitingReply =
    awaitingAssistant && mtime !== null && Date.now() - mtime.getTime() < AWAITING_REPLY_MAX_MS;
  const { status: resolvedStatus, source: statusSource } = resolveStatus({
    registryStatus: registry?.status ?? null,
    registryStale,
    hookStatus: ctx.hook?.status ?? null,
    transcriptLinked: jsonlPath !== null,
    hasError,
    // A prompt/tool result still awaiting Claude's reply, or a tool running in a
    // child process, means the turn is in progress even while CPU is quiet.
    heuristic: () =>
      recentlyAwaitingReply || runningTool
        ? "working"
        : classifyStatus({
            pid: info.pid,
            jsonlMtime: mtime,
            cpuPercent: info.cpuPercent,
            hasError,
            isAskingForInput: askingForInput,
            hasPendingToolUse: pendingToolUse,
          }),
  });

  const status = markRecentlyDone(resolvedStatus, {
    assistantIsNewer: preview.assistantIsNewer,
    lastActivityMs: mtime?.getTime() ?? null,
    now: Date.now(),
  });

  const entrypoint = registry?.entrypoint ?? details?.env.entrypoint ?? null;
  const host = detectSessionHost(info.pid, processTree, {
    entrypoint,
    hasTty: pidHasTty.get(info.pid) ?? false,
    tmuxSession,
  });

  let editorWorkspace: string | null = null;
  let canOpenConversation = false;
  if (host.kind === "vscode-extension" || host.kind === "vscode-terminal") {
    editorWorkspace = resolveWorkspaceForCwd(info.workingDirectory, await readOpenFolders(host.appName));
  }
  if (host.kind === "vscode-extension" && link.sessionId) {
    const comm = processTree.get(info.pid)?.comm ?? "";
    canOpenConversation = await extensionSupportsOpenSession(extensionDirFromBinary(comm));
  }

  // Recent user activity overrides orphan detection — if the session had
  // input within the last 60s it's clearly not abandoned.
  const recentActivity = mtime !== null && Date.now() - mtime.getTime() < 60_000;

  return {
    id: sessionId,
    agent: "claude",
    pid: info.pid,
    workingDirectory: info.workingDirectory,
    repoName: repoNameFromPath(info.workingDirectory),
    parentRepo,
    isWorktree,
    branch: resolvedBranch,
    status,
    lastActivity,
    startedAt,
    git,
    preview,
    hasPendingToolUse: pendingToolUse,
    taskSummary,
    jsonlPath,
    prUrl,
    orphaned: recentActivity ? false : orphaned,
    tmuxSession,
    host,
    entrypoint,
    configDir: registry?.configDir ? configDirLabel(registry.configDir) : null,
    linkSource: jsonlPath || link.sessionId ? link.source : null,
    statusSource,
    editorWorkspace,
    canOpenConversation,
    acceptsInput: hostAcceptsTerminalInput(host),
    sharedProcess: false,
  };
}

export async function discoverSessions(): Promise<ClaudeSession[]> {
  // Single ps call builds the full tree (pid, ppid, %cpu, comm) —
  // extract claude PIDs and their CPU% from it, then one lsof for cwds
  const [processTree, hookStatuses, meta] = await Promise.all([
    buildProcessTree(),
    readAllHookStatuses(),
    loadSessionMeta(),
  ]);
  const allPids = findClaudePidsFromTree(processTree);
  const details = await getProcessDetails(allPids);

  // Config dirs: ~/.claude, ~/.claude-*, plus CLAUDE_CONFIG_DIR of live processes
  const envConfigDirs = new Set<string>();
  for (const d of details.values()) if (d.env.configDir) envConfigDirs.add(d.env.configDir);
  const configDirs = await listClaudeConfigDirs(envConfigDirs);
  const registries = await readSessionRegistries(configDirs, new Set(allPids));

  // Drop helper processes (Chrome native host, MCP server, daemons) — they are not conversations
  const registryByPid = new Map<number, RegistryEntry | null>();
  const pids = allPids.filter((pid) => {
    const d = details.get(pid);
    const reg = selectRegistryEntry(registries.get(pid), d?.startUtc ?? null);
    registryByPid.set(pid, reg);
    if (d && isAuxiliaryClaudeArgs(d.args)) return false;
    if (reg && isAuxiliaryKind(reg.kind)) return false;
    return true;
  });
  const processInfos = await getAllProcessInfos(pids, processTree);

  // Clean up terminal cache entries for dead PIDs
  const activePids = new Set(pids);
  evictStaleTerminalCache(activePids);

  // Orphan check on slower interval — batched to minimize subprocess calls
  const now = Date.now();
  const unchecked = pids.some((pid) => !pidHasTty.has(pid));
  if (now - lastOrphanCheck >= ORPHAN_CHECK_INTERVAL_MS || unchecked) {
    lastOrphanCheck = now;
    const [ttyMap, tmuxPanes, tmuxClients] = await Promise.all([
      getTtysForPids(pids),
      detectAllTmuxPanes(),
      detectTmuxClients(),
    ]);
    // Build set of tmux session names that have at least one attached client
    const attachedTmuxSessions = new Set(tmuxClients.map((c) => c.sessionName));
    const newOrphaned = new Set<number>();
    const newPidTmuxSession = new Map<number, string>();
    const newPidHasTty = new Map<number, boolean>();
    for (const pid of pids) {
      const tty = ttyMap.get(pid);
      newPidHasTty.set(pid, tty !== undefined);
      const paneInfo = tty ? tmuxPanes.get(tty) : undefined;
      const inTmux = paneInfo !== undefined;
      const tmuxSessionHasClient = paneInfo ? attachedTmuxSessions.has(paneInfo.sessionName) : false;
      if (isOrphaned(pid, processTree, inTmux, tmuxSessionHasClient)) {
        newOrphaned.add(pid);
      }
      if (paneInfo) {
        newPidTmuxSession.set(pid, paneInfo.sessionName);
      }
    }
    orphanedPids = newOrphaned;
    pidTmuxSession = newPidTmuxSession;
    pidHasTty = newPidHasTty;
  }

  const contexts: SessionContext[] = processInfos
    .map((info) => {
      // The CLI's registry records cwd as proper UTF-8; prefer it over lsof's output
      const registry = registryByPid.get(info.pid) ?? null;
      return registry?.cwd ? { ...info, workingDirectory: registry.cwd } : info;
    })
    .filter((info): info is ProcessInfo & { workingDirectory: string } => info.workingDirectory !== null)
    .map((info) => {
      const registry = registryByPid.get(info.pid) ?? null;
      const envDir = details.get(info.pid)?.env.configDir ?? null;
      // Search the session's own config dir first; others only as a fallback
      const own = registry?.configDir ?? (envDir && configDirs.includes(envDir) ? envDir : null);
      const ordered = own ? [own, ...configDirs.filter((d) => d !== own)] : configDirs;
      // Hook files are keyed by the hook's parent PID; only trust ones for this live process
      const hook = hookStatuses.get(info.pid);
      return { info, details: details.get(info.pid), registry, hook, configDirs: ordered };
    });

  const links = await Promise.all(contexts.map((ctx) => linkTranscript(ctx)));

  // Inferred fallback for processes with no session ID evidence (old CLIs, no hooks):
  // only when it is the single unlinked process in its project.
  const claimed = new Set(links.map((l) => l.jsonlPath).filter((p): p is string => p !== null));
  const unlinkedByCwd = new Map<string, number>();
  contexts.forEach((ctx, i) => {
    if (!links[i].sessionId) {
      const cwd = ctx.info.workingDirectory;
      unlinkedByCwd.set(cwd, (unlinkedByCwd.get(cwd) ?? 0) + 1);
    }
  });
  await Promise.all(
    contexts.map(async (ctx, i) => {
      if (links[i].sessionId) return;
      const cwd = ctx.info.workingDirectory;
      const dirs = ctx.details?.env.configDir ? [ctx.details.env.configDir] : ctx.configDirs;
      const candidates = (await Promise.all(dirs.map((d) => listTranscripts(projectDirFor(d, cwd))))).flat();
      const startMs = ctx.details?.startUtc ? Date.parse(`${ctx.details.startUtc} UTC`) : NaN;
      const picked = pickInferredTranscript(
        candidates,
        claimed,
        isNaN(startMs) ? null : startMs - 5000,
        unlinkedByCwd.get(cwd) ?? 0,
      );
      if (picked) {
        claimed.add(picked);
        links[i] = { sessionId: null, jsonlPath: picked, source: "inferred" };
      }
    }),
  );

  const [claudeSessions, codexSessions] = await Promise.all([
    Promise.all(
      contexts.map((ctx, i) =>
        buildSession(
          ctx,
          links[i],
          processTree,
          orphanedPids.has(ctx.info.pid),
          pidTmuxSession.get(ctx.info.pid) ?? null,
        ),
      ),
    ),
    // Codex failures must never break Claude discovery
    discoverCodexSessions(processTree).catch(() => [] as ClaudeSession[]),
  ]);
  const sessions = [...claudeSessions, ...codexSessions];

  // Processes that exited since the last poll: show them as finished for a short while
  const sessionKey = (s: ClaudeSession) => `${s.id}-${s.pid}`;
  const alive = new Set(sessions.map(sessionKey));
  // An empty tree means `ps` failed — don't mistake that for every process exiting
  for (const [key, prev] of processTree.size > 0 ? previousSessions : []) {
    const pid = prev.pid as number;
    if (!alive.has(key) && !processTree.has(pid)) {
      recentlyFinished.set(prev.id, {
        session: {
          ...prev,
          pid: null,
          status: "finished",
          statusSource: "process-exit",
          orphaned: false,
          acceptsInput: false,
        },
        endedAt: now,
      });
    }
  }
  previousSessions = new Map(sessions.map((s) => [sessionKey(s), s]));
  const liveIds = new Set(sessions.map((s) => s.id));
  for (const [id, entry] of recentlyFinished) {
    if (now - entry.endedAt > FINISHED_RETENTION_MS || liveIds.has(id)) recentlyFinished.delete(id);
    else sessions.push(entry.session);
  }

  // Merge user-provided title/description overrides
  for (const session of sessions) {
    const overrides = meta[session.id];
    if (!overrides) continue;
    if (!session.taskSummary) {
      session.taskSummary = { title: "", description: null, source: "user", ticketId: null, ticketUrl: null };
    }
    if (overrides.title !== undefined) {
      session.taskSummary.title = overrides.title;
      session.taskSummary.source = "user";
    }
    if (overrides.description !== undefined) {
      session.taskSummary.description = overrides.description;
    }
  }

  return sessions;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const sessions = await discoverSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return null;

  let conversation: SessionDetail["conversation"] = [];
  let gitDiff: string | null = null;

  if (session.jsonlPath) {
    const allLines = await readFullConversation(session.jsonlPath);
    conversation =
      session.agent === "codex"
        ? codexLinesToConversation(allLines as unknown as CodexLine[])
        : linesToConversation(allLines);
  }

  gitDiff = await getGitDiff(session.workingDirectory);

  return {
    ...session,
    conversation,
    gitDiff,
  };
}
