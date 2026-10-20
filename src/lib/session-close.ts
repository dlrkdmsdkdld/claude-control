import { readFile } from "fs/promises";
import type { ProcessTreeEntry } from "./terminal/types";

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);

function shellName(comm: string): string | null {
  const base = (comm.includes("/") ? comm.split("/").pop() || comm : comm).replace(/^-/, "");
  return SHELLS.has(base) ? base : null;
}

/**
 * The shell that owns the terminal tab running a claude process: the topmost
 * shell ancestor below the hosting app (or below login/launchd). Wrappers in
 * between (e.g. a node launcher) are skipped. When that shell exits, terminal
 * hosts close or end the tab. Returns null if no shell owns the process.
 */
export function findTabShell(pid: number, processTree: Map<number, ProcessTreeEntry>): number | null {
  let tabShell: number | null = null;
  let current = processTree.get(pid)?.ppid ?? 0;
  const visited = new Set<number>();
  while (current > 1 && !visited.has(current)) {
    visited.add(current);
    const entry = processTree.get(current);
    if (!entry) break;
    if (entry.comm.includes(".app/")) break;
    if (shellName(entry.comm)) tabShell = current;
    current = entry.ppid;
  }
  return tabShell;
}

/** Most recent conversation title (user rename wins over the AI title) from a transcript. */
export function extractConversationTitle(jsonl: string): string | null {
  let ai: string | null = null;
  let custom: string | null = null;
  for (const m of jsonl.matchAll(/"(aiTitle|customTitle)":"((?:[^"\\]|\\.)*)"/g)) {
    let value: string;
    try {
      value = JSON.parse(`"${m[2]}"`);
    } catch {
      continue;
    }
    if (m[1] === "customTitle") custom = value;
    else ai = value;
  }
  return custom ?? ai;
}

export async function readConversationTitle(jsonlPath: string | null): Promise<string | null> {
  if (!jsonlPath) return null;
  try {
    return extractConversationTitle(await readFile(jsonlPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Whether a VS Code window title ("<active editor> — <folder>") shows the
 * given conversation tab as the active editor. Handles the "●" dirty marker
 * and titles VS Code truncated with "…".
 */
export function windowShowsConversation(windowTitle: string, conversationTitle: string): boolean {
  const editor = windowTitle.split(" — ")[0].replace(/^●\s*/, "").trim();
  const title = conversationTitle.trim();
  if (!editor || !title) return false;
  if (editor === title) return true;
  if (editor.endsWith("…")) {
    const prefix = editor.slice(0, -1).trim();
    return prefix.length >= 4 && title.startsWith(prefix);
  }
  return false;
}
