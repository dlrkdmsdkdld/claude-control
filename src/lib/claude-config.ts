import { access, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Claude Code keeps per-account state (projects/, sessions/, settings.json)
 * in a config directory: ~/.claude by default, or $CLAUDE_CONFIG_DIR.
 * Users with several accounts commonly use ~/.claude-<name> directories.
 */

const CONFIG_DIR_NAME = /^\.claude(-[A-Za-z0-9._-]+)?$/;
// Directories matching the pattern that are not Claude Code config dirs
const NOT_CONFIG_DIRS = new Set([".claude-control"]);

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List candidate Claude config directories: ~/.claude, ~/.claude-* (that
 * contain a sessions/ or projects/ dir), plus any explicit extra dirs
 * (e.g. CLAUDE_CONFIG_DIR values seen on running processes).
 */
export async function listClaudeConfigDirs(extraDirs: Iterable<string> = []): Promise<string[]> {
  const home = homedir();
  const result = new Set<string>();

  let entries: string[] = [];
  try {
    entries = await readdir(home);
  } catch {
    // ignore
  }
  const candidates = entries
    .filter((e) => CONFIG_DIR_NAME.test(e) && !NOT_CONFIG_DIRS.has(e))
    .map((e) => join(home, e));
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push(process.env.CLAUDE_CONFIG_DIR);
  for (const d of extraDirs) candidates.push(d);

  await Promise.all(
    candidates.map(async (dir) => {
      if ((await isDir(join(dir, "sessions"))) || (await isDir(join(dir, "projects")))) {
        result.add(dir.replace(/\/+$/, ""));
      }
    }),
  );
  return Array.from(result).sort();
}

/**
 * Claude Code's project directory name for a cwd: every character that is not
 * an ASCII letter or digit becomes "-" (one per UTF-16 code unit, matching the
 * CLI's JavaScript implementation). "/a/my_app" → "-a-my-app", "성경" → "--".
 */
export function escapeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the transcript for a known session ID. Tries the expected
 * <configDir>/projects/<escaped cwd>/<id>.jsonl first, then scans every
 * project dir of the config dir (covers long-path hashing and cwd changes).
 * Only ever returns a file named after the session ID — never a guess.
 */
export async function findTranscriptForSession(
  configDirs: string[],
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const fileName = `${sessionId}.jsonl`;
  for (const dir of configDirs) {
    const expected = join(dir, "projects", escapeProjectDirName(cwd), fileName);
    if (await exists(expected)) return expected;
  }
  for (const dir of configDirs) {
    const projectsDir = join(dir, "projects");
    let projects: string[];
    try {
      projects = await readdir(projectsDir);
    } catch {
      continue;
    }
    for (const p of projects) {
      const candidate = join(projectsDir, p, fileName);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Project directory (holding transcripts) for a cwd within a config dir. */
export function projectDirFor(configDir: string, cwd: string): string {
  return join(configDir, "projects", escapeProjectDirName(cwd));
}

/** Short display label for a config dir: "~/.claude-acct2". */
export function configDirLabel(dir: string): string {
  const home = homedir();
  return dir.startsWith(home + "/") ? `~/${dir.slice(home.length + 1)}` : dir;
}
