import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { SessionStatus } from "./types";

/**
 * Claude Code (≥ 2.1) writes a live registry file per running process at
 * <configDir>/sessions/<pid>.json with the session ID, cwd, entrypoint
 * ("cli", "claude-vscode", …) and a status the CLI keeps up to date. This is
 * the most direct evidence linking a PID to its conversation. The sibling
 * *.key files are secrets and are never read.
 */
export interface RegistryEntry {
  pid: number;
  sessionId: string | null;
  cwd: string | null;
  /** Process start time as written by the CLI (UTC, `ps -o lstart` format). */
  procStart: string | null;
  kind: string | null;
  entrypoint: string | null;
  status: string | null;
  waitingFor: string | null;
  name: string | null;
  updatedAt: number | null;
  configDir: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseRegistryEntry(raw: string, configDir: string): RegistryEntry | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.pid !== "number") return null;
  return {
    pid: data.pid,
    sessionId: str(data.sessionId),
    cwd: str(data.cwd),
    procStart: str(data.procStart),
    kind: str(data.kind),
    entrypoint: str(data.entrypoint),
    status: str(data.status),
    waitingFor: str(data.waitingFor),
    name: str(data.name),
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : null,
    configDir,
  };
}

/** Read every config dir's sessions/<pid>.json for the given live PIDs. */
export async function readSessionRegistries(
  configDirs: string[],
  livePids: Set<number>,
): Promise<Map<number, RegistryEntry[]>> {
  const result = new Map<number, RegistryEntry[]>();
  await Promise.all(
    configDirs.map(async (configDir) => {
      const dir = join(configDir, "sessions");
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          const m = f.match(/^(\d+)\.json$/);
          if (!m) return;
          const pid = parseInt(m[1], 10);
          if (!livePids.has(pid)) return;
          try {
            const entry = parseRegistryEntry(await readFile(join(dir, f), "utf-8"), configDir);
            if (entry && entry.pid === pid) {
              const list = result.get(pid) ?? [];
              list.push(entry);
              result.set(pid, list);
            }
          } catch {
            // unreadable — skip
          }
        }),
      );
    }),
  );
  return result;
}

/** Compare two `ps -o lstart` style timestamps, tolerating small skew. */
export function sameProcessStart(a: string, b: string): boolean {
  const ta = Date.parse(`${a} UTC`);
  const tb = Date.parse(`${b} UTC`);
  if (isNaN(ta) || isNaN(tb)) return a.trim() === b.trim();
  return Math.abs(ta - tb) <= 2000;
}

/**
 * Pick the registry entry that belongs to this live process. A PID can be
 * reused, so an entry whose procStart disagrees with the process's real start
 * time (from `TZ=UTC ps -o lstart`) is rejected. If several config dirs claim
 * the PID, the one with a matching start time and newest update wins.
 */
export function selectRegistryEntry(
  entries: RegistryEntry[] | undefined,
  actualStartUtc: string | null,
): RegistryEntry | null {
  if (!entries || entries.length === 0) return null;
  const valid = entries.filter((e) => !e.procStart || !actualStartUtc || sameProcessStart(e.procStart, actualStartUtc));
  if (valid.length === 0) return null;
  valid.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return valid[0];
}

/** Registry kinds that are helpers rather than user conversations. */
const AUXILIARY_KINDS = new Set(["daemon", "daemon-worker"]);

export function isAuxiliaryKind(kind: string | null): boolean {
  return kind !== null && AUXILIARY_KINDS.has(kind);
}

/**
 * Map the CLI's own status ("busy" | "shell" | "idle" | "waiting") to ours.
 * Returns null for unknown/missing values so callers fall back to other evidence.
 */
export function statusFromRegistry(status: string | null): SessionStatus | null {
  switch (status) {
    case "busy":
    case "shell":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return null;
  }
}
