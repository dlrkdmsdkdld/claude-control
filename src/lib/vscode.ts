import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

/** User-data folder name per VS Code–family app (under ~/Library/Application Support). */
const USER_DATA_DIRS: Record<string, string> = {
  "Visual Studio Code": "Code",
  "Visual Studio Code - Insiders": "Code - Insiders",
  Cursor: "Cursor",
  Windsurf: "Windsurf",
  VSCodium: "VSCodium",
};

/** Folders currently open in windows, parsed from VS Code's storage.json windowsState. */
export function parseOpenFolders(storageJson: string): string[] {
  let data: { windowsState?: { lastActiveWindow?: { folder?: string }; openedWindows?: { folder?: string }[] } };
  try {
    data = JSON.parse(storageJson);
  } catch {
    return [];
  }
  const ws = data.windowsState;
  if (!ws) return [];
  const uris = [ws.lastActiveWindow?.folder, ...(ws.openedWindows ?? []).map((w) => w.folder)];
  const folders = new Set<string>();
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
    try {
      folders.add(fileURLToPath(uri).replace(/\/+$/, ""));
    } catch {
      // malformed URI
    }
  }
  return Array.from(folders);
}

const storageCache = new Map<string, { mtimeMs: number; folders: string[] }>();

export async function readOpenFolders(appName: string | null): Promise<string[]> {
  const dirName = USER_DATA_DIRS[appName ?? ""] ?? "Code";
  const file = join(homedir(), "Library", "Application Support", dirName, "User", "globalStorage", "storage.json");
  try {
    const s = await stat(file);
    const cached = storageCache.get(file);
    if (cached && cached.mtimeMs === s.mtimeMs) return cached.folders;
    const folders = parseOpenFolders(await readFile(file, "utf-8"));
    storageCache.set(file, { mtimeMs: s.mtimeMs, folders });
    return folders;
  } catch {
    return [];
  }
}

/**
 * The open window folder that contains cwd (exact match, else the deepest
 * ancestor). Null when no open window covers it.
 */
export function resolveWorkspaceForCwd(cwd: string, openFolders: string[]): string | null {
  let best: string | null = null;
  for (const folder of openFolders) {
    if (cwd === folder || cwd.startsWith(folder + "/")) {
      if (!best || folder.length > best.length) best = folder;
    }
  }
  return best;
}

/** Extension directory from the bundled CLI path (…/extensions/<id>-<ver>/resources/native-binary/claude). */
export function extensionDirFromBinary(binaryPath: string): string | null {
  const m = binaryPath.match(/^(.*\/extensions\/anthropic\.claude-code-[^/]+)\//);
  return m ? m[1] : null;
}

const uriSupportCache = new Map<string, boolean>();

/**
 * Whether the Claude Code extension at extDir registers a URI handler for
 * /open?session=<id>. Checked against the shipped extension.js rather than
 * assumed, so older extensions don't get a button that silently does nothing.
 */
export async function extensionSupportsOpenSession(extDir: string | null): Promise<boolean> {
  if (!extDir) return false;
  const cached = uriSupportCache.get(extDir);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const src = await readFile(join(extDir, "extension.js"), "utf-8");
    supported = src.includes("registerUriHandler") && /case\s*"\/open"/.test(src) && src.includes('get("session")');
  } catch {
    supported = false;
  }
  uriSupportCache.set(extDir, supported);
  return supported;
}

/** vscode://anthropic.claude-code/open?session=<id> (scheme varies by editor). */
export function conversationUri(uriScheme: string, sessionId: string): string {
  return `${uriScheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
}
