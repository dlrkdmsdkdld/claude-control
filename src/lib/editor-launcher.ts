import { execFile } from "child_process";
import { realpath } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { EditorOption } from "./config";
import { getShellEnv } from "./shell-env";
import { appBundleFromComm } from "./session-host";
import type { ProcessTreeEntry } from "./terminal/types";

const execFileAsync = promisify(execFile);
const realpathNative = promisify(realpath.native);

export type AppSource = "settings" | "running" | "standard-location" | "spotlight";

export interface ResolvedApp {
  bundlePath: string;
  source: AppSource;
}

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly attempts: string[] = [],
  ) {
    super(message);
  }
}

/** CFBundleIdentifier of an .app bundle, or null if it isn't a readable app. */
export async function readBundleId(bundlePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(bundlePath, "Contents", "Info.plist")],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function matchesBundle(bundlePath: string, def: EditorOption): Promise<boolean> {
  if (!(await isDirectory(bundlePath))) return false;
  if (!def.bundleIds?.length) return true;
  const id = await readBundleId(bundlePath);
  return id !== null && def.bundleIds.includes(id);
}

/** CFBundleExecutable of an .app bundle (the process name System Events knows it by). */
export async function readBundleExecutable(bundlePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(bundlePath, "Contents", "Info.plist")],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Folders checked for `<App Name>.app` besides Spotlight — Desktop/Downloads installs are common. */
export function standardAppLocations(appName: string): string[] {
  const home = homedir();
  return ["/Applications", join(home, "Applications"), join(home, "Desktop"), join(home, "Downloads")].map((d) =>
    join(d, `${appName}.app`),
  );
}

/** Bundles of running processes whose main executable matches the editor (e.g. ".../Code.app/Contents/MacOS/Code"). */
export function runningBundles(processTree: Map<number, ProcessTreeEntry>, def: EditorOption): string[] {
  const found = new Set<string>();
  for (const entry of processTree.values()) {
    const bundle = appBundleFromComm(entry.comm);
    if (bundle && entry.comm === `${bundle}/Contents/MacOS/${def.processName}`) found.add(bundle);
  }
  return Array.from(found);
}

async function spotlightBundles(def: EditorOption): Promise<string[]> {
  if (!def.bundleIds?.length) return [];
  const query = def.bundleIds.map((id) => `kMDItemCFBundleIdentifier == '${id}'`).join(" || ");
  try {
    const { stdout } = await execFileAsync("mdfind", [query], { timeout: 3000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".app") && !l.includes("/.Trash/"));
  } catch {
    return [];
  }
}

/**
 * Find the editor's .app bundle. Order: path chosen in Settings → the copy that
 * is currently running → standard folders (/Applications, ~/Applications,
 * ~/Desktop, ~/Downloads) → Spotlight by bundle ID. Every candidate's bundle
 * ID is verified so an unrelated app with the same name is never launched.
 */
export async function resolveEditorApp(
  def: EditorOption,
  overridePath: string | undefined,
  processTree: Map<number, ProcessTreeEntry> | null,
): Promise<ResolvedApp | null> {
  if (overridePath) {
    if (await matchesBundle(overridePath, def)) return { bundlePath: overridePath, source: "settings" };
    throw new LaunchError(
      `설정에 지정한 ${def.label} 경로를 열 수 없습니다: ${overridePath}`,
      `Settings → Tools에서 ${def.label} 앱 위치를 다시 선택하거나 '자동 감지'로 되돌리세요.`,
    );
  }
  if (processTree) {
    for (const b of runningBundles(processTree, def)) {
      if (await matchesBundle(b, def)) return { bundlePath: b, source: "running" };
    }
  }
  for (const b of standardAppLocations(def.appName)) {
    if (await matchesBundle(b, def)) return { bundlePath: b, source: "standard-location" };
  }
  for (const b of await spotlightBundles(def)) {
    if (await matchesBundle(b, def)) return { bundlePath: b, source: "spotlight" };
  }
  return null;
}

async function commandOnPath(command: string): Promise<boolean> {
  if (!command) return false;
  try {
    await execFileAsync("which", [command], { timeout: 3000, env: await getShellEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Projects a JetBrains IDE currently has open, from its recentProjects.xml
 * (entries flagged opened="true"; $USER_HOME$ expanded, NFC-normalized).
 */
export function parseOpenJetBrainsProjects(xml: string, home: string): string[] {
  const out: string[] = [];
  const re = /<entry key="([^"]+)">\s*<value>\s*<RecentProjectMetaInfo([^>]*)>/g;
  for (const m of xml.matchAll(re)) {
    if (!/\bopened="true"/.test(m[2])) continue;
    const key = m[1]
      .replace(/^\$USER_HOME\$/, home)
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    out.push(key.normalize("NFC").replace(/\/+$/, ""));
  }
  return out;
}

/** Open projects of the most recently used config dir of a JetBrains IDE (e.g. Google/AndroidStudio2025.1.1). */
async function openJetBrainsProjects(prefix: string): Promise<string[]> {
  const base = join(homedir(), "Library", "Application Support");
  const [vendor, product] = prefix.split("/");
  let best: { file: string; mtimeMs: number } | null = null;
  try {
    for (const entry of await readdir(join(base, vendor))) {
      if (!entry.startsWith(product)) continue;
      const file = join(base, vendor, entry, "options", "recentProjects.xml");
      try {
        const s = await stat(file);
        if (!best || s.mtimeMs > best.mtimeMs) best = { file, mtimeMs: s.mtimeMs };
      } catch {
        // no recent projects for this version
      }
    }
    return best ? parseOpenJetBrainsProjects(await readFile(best.file, "utf-8"), homedir()) : [];
  } catch {
    return [];
  }
}

/**
 * Open a folder (or URL) in the editor. `open -a <bundle> <target>` goes
 * through LaunchServices: it needs no CLI on PATH, passes the path as a single
 * argv entry (spaces/Korean are safe), doesn't leak this server's environment
 * into the editor, and focuses the existing window when the folder is already
 * open. The editor's own CLI on PATH is the last fallback.
 */
export async function openInEditor(
  def: EditorOption,
  target: string,
  opts: { overridePath?: string; processTree: Map<number, ProcessTreeEntry> | null; preferBundle?: string | null },
): Promise<{ method: string; bundlePath: string | null }> {
  const attempts: string[] = [];

  // Use the on-disk spelling of the path (realpath(3) returns the stored Unicode
  // normalization, e.g. NFD Korean): editors that match open windows by path
  // string otherwise treat the same folder as a different project.
  if (!target.includes("://")) target = await realpathNative(target).catch(() => target);

  let resolved: ResolvedApp | null = null;
  if (opts.preferBundle && (await matchesBundle(opts.preferBundle, def))) {
    resolved = { bundlePath: opts.preferBundle, source: "running" };
  } else {
    resolved = await resolveEditorApp(def, opts.overridePath, opts.processTree);
  }

  // Already open in a JetBrains IDE: re-sending the folder opens a duplicate
  // frame, so only bring the IDE to the front.
  if (resolved && def.jetbrainsConfigPrefix) {
    const open = await openJetBrainsProjects(def.jetbrainsConfigPrefix);
    if (open.includes(target.normalize("NFC"))) {
      await execFileAsync("open", ["-a", resolved.bundlePath], { timeout: 10000 });
      return { method: "already open — activated app only", bundlePath: resolved.bundlePath };
    }
  }

  if (resolved) {
    try {
      await execFileAsync("open", ["-a", resolved.bundlePath, target], { timeout: 10000 });
      return { method: `open -a (${resolved.source})`, bundlePath: resolved.bundlePath };
    } catch (err) {
      attempts.push(`open -a "${resolved.bundlePath}": ${(err as Error).message.split("\n")[0]}`);
    }
  } else {
    attempts.push(`${def.label} 앱을 찾지 못함 (/Applications, ~/Applications, ~/Desktop, ~/Downloads, Spotlight)`);
  }

  for (const id of def.bundleIds ?? []) {
    try {
      await execFileAsync("open", ["-b", id, target], { timeout: 10000 });
      return { method: `open -b ${id}`, bundlePath: null };
    } catch (err) {
      attempts.push(`open -b ${id}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  if (def.command && !target.includes("://") && (await commandOnPath(def.command))) {
    try {
      await execFileAsync(def.command, [target], { timeout: 10000, env: await getShellEnv() });
      return { method: `${def.command} CLI`, bundlePath: null };
    } catch (err) {
      attempts.push(`${def.command} ${target}: ${(err as Error).message.split("\n")[0]}`);
    }
  } else if (def.command) {
    attempts.push(`'${def.command}' 명령이 PATH에 없음`);
  }

  throw new LaunchError(
    `${def.label}(으)로 열지 못했습니다.`,
    `${def.label}이(가) 설치돼 있다면 Settings → Tools → '${def.label} 앱 위치'에서 .app을 직접 선택하세요.`,
    attempts,
  );
}
