import type { HookStatus } from "./hooks-reader";
import type { RegistryEntry } from "./session-registry";
import { statusFromRegistry } from "./session-registry";
import type { ClaudeSession, SessionStatus, TranscriptLinkSource } from "./types";

export interface LinkEvidence {
  registry: RegistryEntry | null;
  hook: HookStatus | undefined;
  argsSessionId: string | null;
}

/**
 * Session ID for a live process, from the strongest available evidence.
 * Never derived from "newest file in the project" — see pickInferredTranscript.
 */
export function chooseSessionId(e: LinkEvidence): { sessionId: string; source: TranscriptLinkSource } | null {
  if (e.registry?.sessionId) return { sessionId: e.registry.sessionId, source: "registry" };
  if (e.hook?.sessionId) return { sessionId: e.hook.sessionId, source: "hook" };
  if (e.argsSessionId) return { sessionId: e.argsSessionId, source: "args" };
  return null;
}

export interface StatusInput {
  registryStatus: string | null;
  hookStatus: SessionStatus | null;
  transcriptLinked: boolean;
  hasError: boolean;
  /** Transcript/CPU heuristic; only consulted when a transcript is linked. */
  heuristic: () => SessionStatus;
}

/**
 * Status precedence: the CLI's own registry status, then claude-control hook
 * events, then the transcript heuristic. Without any of these the status is
 * "unknown" — an unlinked session is never reported as idle.
 */
export function resolveStatus(input: StatusInput): { status: SessionStatus; source: ClaudeSession["statusSource"] } {
  const fromRegistry = statusFromRegistry(input.registryStatus);
  if (fromRegistry) {
    if (fromRegistry === "idle" && input.hasError) return { status: "errored", source: "registry" };
    return { status: fromRegistry, source: "registry" };
  }
  if (input.hookStatus) return { status: input.hookStatus, source: "hook" };
  if (input.transcriptLinked) return { status: input.heuristic(), source: "transcript" };
  return { status: "unknown", source: "none" };
}

export interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * Last-resort link for a process with no session ID evidence. Only allowed
 * when this is the sole unlinked process in its project (so one file can't be
 * handed to several sessions), and only to a transcript that no other session
 * claims and that was written after the process started.
 */
export function pickInferredTranscript(
  candidates: TranscriptCandidate[],
  claimed: Set<string>,
  processStartMs: number | null,
  unlinkedProcessesInProject: number,
): string | null {
  if (unlinkedProcessesInProject !== 1) return null;
  if (processStartMs === null) return null;
  let best: TranscriptCandidate | null = null;
  for (const c of candidates) {
    if (claimed.has(c.path)) continue;
    if (c.mtimeMs < processStartMs) continue;
    if (!best || c.mtimeMs > best.mtimeMs) best = c;
  }
  return best?.path ?? null;
}
