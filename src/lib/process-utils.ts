import { execFile } from "child_process";
import { promisify } from "util";
import { PROCESS_TIMEOUT_MS } from "./constants";
import type { ProcessTreeEntry } from "./terminal/types";

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  workingDirectory: string | null;
  cpuPercent: number;
}

/**
 * lsof prints bytes outside printable ASCII as `\xNN` (e.g. Korean folder
 * names). Turn those escapes back into the original UTF-8 path.
 */
export function decodeLsofName(name: string): string {
  if (!name.includes("\\x")) return name;
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const m = name.slice(i, i + 4).match(/^\\x([0-9a-fA-F]{2})$/);
    if (m) {
      bytes.push(parseInt(m[1], 16));
      i += 3;
    } else {
      bytes.push(...Buffer.from(name[i], "utf-8"));
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Get working directories for multiple PIDs in a single `lsof` call.
 * Uses `-Fpn -d cwd` for parseable output filtered to cwd entries only.
 * Output format: p<pid>\nfcwd\nn<path> per process — `f` lines are
 * intentionally skipped since we only need `p` (PID) and `n` (path).
 */
export async function getBatchWorkingDirectories(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  try {
    const { stdout } = await execFileAsync("lsof", ["-p", pids.join(","), "-Fpn", "-d", "cwd"], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    let currentPid: number | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith("n") && currentPid !== null) {
        result.set(currentPid, decodeLsofName(line.slice(1)));
        currentPid = null;
      }
    }
  } catch {
    /* ignore — PIDs may have exited */
  }
  return result;
}

/**
 * Check whether a PID belongs to a "claude" process.
 * Returns true only when the process exists and its command name is "claude".
 */
export async function isClaudeProcess(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", String(pid)], {
      timeout: PROCESS_TIMEOUT_MS,
    });
    const comm = stdout.trim();
    const basename = comm.includes("/") ? comm.split("/").pop() || comm : comm;
    return basename === "claude";
  } catch {
    return false;
  }
}

/**
 * Build ProcessInfo for all given PIDs using the process tree + one lsof call.
 * The tree (from buildProcessTree) provides comm and %cpu; lsof provides cwds.
 * Since findClaudePidsFromTree already filters by `comm === "claude"`, the
 * Claude.app desktop process (comm "Claude" or "Electron") never reaches here.
 */
export async function getAllProcessInfos(
  pids: number[],
  processTree: Map<number, ProcessTreeEntry>,
): Promise<ProcessInfo[]> {
  if (pids.length === 0) return [];

  const cwds = await getBatchWorkingDirectories(pids);

  const results: ProcessInfo[] = [];
  for (const pid of pids) {
    const entry = processTree.get(pid);
    if (!entry) continue;

    results.push({
      pid,
      workingDirectory: cwds.get(pid) ?? null,
      cpuPercent: entry.cpuPercent,
    });
  }
  return results;
}

export interface ProcessDetails {
  args: string;
  /** Start time in UTC `ps -o lstart` format — matches the CLI's registry procStart. */
  startUtc: string | null;
  /** Only whitelisted variables are kept; the rest of the environment is discarded unread. */
  env: { configDir: string | null; entrypoint: string | null };
}

const ENV_HINT_KEYS = { CLAUDE_CONFIG_DIR: "configDir", CLAUDE_CODE_ENTRYPOINT: "entrypoint" } as const;

/**
 * Extract whitelisted env hints from the env portion of `ps -E` output.
 * Values containing spaces are truncated by ps' formatting; callers must
 * validate them (e.g. check the directory exists) before trusting them.
 */
export function parseEnvHints(envPart: string): ProcessDetails["env"] {
  const env: ProcessDetails["env"] = { configDir: null, entrypoint: null };
  for (const [key, field] of Object.entries(ENV_HINT_KEYS)) {
    const m = envPart.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
    if (m) env[field] = m[1];
  }
  return env;
}

/** Arguments that mark a claude binary as a helper process, not a conversation. */
const AUXILIARY_ARGS = [
  /(?:^|\s)--chrome-native-host(?:\s|$)/,
  /(?:^|\s)mcp\s+serve(?:\s|$)/,
  /(?:^|\s)--daemon(?:\s|$)/,
];

/**
 * Helper processes and one-shot runs that aren't conversations. `claude -p`
 * (print mode, e.g. a script polling `claude -p /usage`) exits after one reply;
 * SDK hosts that keep streaming input (`--input-format stream-json`) are kept.
 */
export function isAuxiliaryClaudeArgs(args: string): boolean {
  if (AUXILIARY_ARGS.some((re) => re.test(args))) return true;
  const printMode = /(?:^|\s)(?:-p|--print)(?:\s|=|$)/.test(args);
  const streamingInput = /(?:^|\s)--input-format(?:=|\s+)stream-json(?:\s|$)/.test(args);
  return printMode && !streamingInput;
}

/** Session ID passed on the command line (`--resume=<id>`, `--resume <id>`, `--session-id <id>`). */
export function sessionIdFromArgs(args: string): string | null {
  const m = args.match(
    /(?:^|\s)--(?:resume|session-id)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i,
  );
  return m ? m[1].toLowerCase() : null;
}

/**
 * Batch-read args, UTC start time and env hints for claude PIDs.
 * Uses two `ps` calls; `ps -E` appends the environment after the args, so the
 * env part is everything after the plain args string.
 */
export async function getProcessDetails(pids: number[]): Promise<Map<number, ProcessDetails>> {
  const result = new Map<number, ProcessDetails>();
  if (pids.length === 0) return result;
  const list = pids.join(",");
  const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
  const [argsOut, envOut, startOut] = await Promise.all([
    execFileAsync("ps", ["-ww", "-o", "pid=,args=", "-p", list], { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 8 << 20 })
      .then((r) => r.stdout)
      .catch(() => ""),
    execFileAsync("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", list], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    })
      .then((r) => r.stdout)
      .catch(() => ""),
    execFileAsync("ps", ["-o", "pid=,lstart=", "-p", list], { timeout: PROCESS_TIMEOUT_MS, env })
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const byPid = (out: string) => {
    const m = new Map<number, string>();
    for (const line of out.split("\n")) {
      const match = line.match(/^\s*(\d+)\s(.*)$/);
      if (match) m.set(parseInt(match[1], 10), match[2]);
    }
    return m;
  };
  const argsMap = byPid(argsOut);
  const envMap = byPid(envOut);
  const startMap = byPid(startOut);

  for (const pid of pids) {
    const args = (argsMap.get(pid) ?? "").trim();
    const combined = envMap.get(pid) ?? "";
    const idx = args ? combined.indexOf(args) : -1;
    const envPart = idx >= 0 ? combined.slice(idx + args.length) : "";
    result.set(pid, {
      args,
      startUtc: startMap.get(pid)?.trim() || null,
      env: parseEnvHints(envPart),
    });
  }
  return result;
}
