import { execFile } from "child_process";
import { access } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { NextResponse } from "next/server";
import { promisify } from "util";
import {
  AppConfig,
  BROWSER_OPTIONS,
  EDITOR_OPTIONS,
  GIT_GUI_OPTIONS,
  loadConfig,
  saveConfig,
  TERMINAL_APP_OPTIONS,
  TERMINAL_OPEN_IN_OPTIONS,
  TERMINAL_TMUX_MODE_OPTIONS,
} from "@/lib/config";
import { LaunchError, resolveEditorApp } from "@/lib/editor-launcher";
import { getShellEnv } from "@/lib/shell-env";
import { buildProcessTree } from "@/lib/terminal";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

async function checkInstalledApps<T extends { appName: string; command?: string }>(
  options: T[],
  alwaysInstalled?: Set<string>,
): Promise<(T & { installed: boolean })[]> {
  const env = await getShellEnv();
  return Promise.all(
    options.map(async (opt) => {
      if (!opt.appName || alwaysInstalled?.has(opt.appName)) return { ...opt, installed: true };
      // Try macOS app bundle first, then CLI command as fallback
      const checks = [
        execFileAsync("open", ["-Ra", opt.appName], { timeout: 3000 }).then(
          () => true,
          () => false,
        ),
      ];
      if (opt.command) {
        checks.push(
          execFileAsync("which", [opt.command], { timeout: 3000, env }).then(
            () => true,
            () => false,
          ),
        );
      }
      const results = await Promise.all(checks);
      return { ...opt, installed: results.some(Boolean) };
    }),
  );
}

/** Editors are resolved the same way the open action does, so "installed" matches what will launch. */
async function checkEditors(appPaths: Record<string, string>) {
  const tree = await buildProcessTree();
  return Promise.all(
    EDITOR_OPTIONS.map(async (opt) => {
      if (!opt.appName) return { ...opt, installed: true, appPath: null, appSource: null, appError: null };
      try {
        const resolved = await resolveEditorApp(opt, appPaths[opt.id], tree);
        if (resolved)
          return { ...opt, installed: true, appPath: resolved.bundlePath, appSource: resolved.source, appError: null };
      } catch (err) {
        if (err instanceof LaunchError) {
          return { ...opt, installed: false, appPath: appPaths[opt.id], appSource: "settings", appError: err.message };
        }
      }
      // No bundle found — the CLI alone still works as a fallback
      const hasCli = opt.command
        ? await execFileAsync("which", [opt.command], { timeout: 3000, env: await getShellEnv() }).then(
            () => true,
            () => false,
          )
        : false;
      return { ...opt, installed: hasCli, appPath: null, appSource: null, appError: null };
    }),
  );
}

interface DependencyDef {
  id: string;
  label: string;
  description: string;
  command: string;
  url: string;
  knownPaths?: string[];
}

const home = homedir();

const DEPENDENCIES: DependencyDef[] = [
  {
    id: "gh",
    label: "GitHub CLI",
    description: "Pull request detection and status checks",
    command: "gh",
    url: "https://cli.github.com",
    knownPaths: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "The whole reason this app exists",
    command: "claude",
    url: "https://docs.anthropic.com/en/docs/claude-code",
    knownPaths: [
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ],
  },
  {
    id: "tmux",
    label: "tmux",
    description: "Background terminal sessions and send-keys support",
    command: "tmux",
    url: "https://github.com/tmux/tmux",
    knownPaths: ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"],
  },
];

async function checkDependencies(): Promise<(DependencyDef & { installed: boolean })[]> {
  const env = await getShellEnv();
  return Promise.all(
    DEPENDENCIES.map(async (dep) => {
      // Try `which` first
      try {
        await execFileAsync("which", [dep.command], { timeout: 3000, env });
        return { ...dep, installed: true };
      } catch {
        // Fall through to known paths
      }
      // Fallback: check known install locations directly
      if (dep.knownPaths) {
        for (const p of dep.knownPaths) {
          try {
            await access(p);
            return { ...dep, installed: true };
          } catch {
            // Not at this path
          }
        }
      }
      return { ...dep, installed: false };
    }),
  );
}

export async function GET() {
  try {
    const config = await loadConfig();
    const [terminalApps, browsers, editors, gitGuis, dependencies] = await Promise.all([
      checkInstalledApps(TERMINAL_APP_OPTIONS, new Set(["Terminal"])),
      checkInstalledApps(BROWSER_OPTIONS, new Set(["Safari"])),
      checkEditors(config.editorAppPaths ?? {}),
      checkInstalledApps(GIT_GUI_OPTIONS),
      checkDependencies(),
    ]);

    return NextResponse.json({
      config,
      options: {
        editors,
        gitGuis,
        browsers,
        terminalApps,
        terminalOpenIn: TERMINAL_OPEN_IN_OPTIONS,
        terminalTmuxModes: TERMINAL_TMUX_MODE_OPTIONS,
      },
      dependencies,
    });
  } catch (error) {
    console.error("Failed to load settings:", error);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

function sanitizeAppPaths(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(value as Record<string, unknown>)) {
    if (EDITOR_OPTIONS.some((e) => e.id === id) && typeof p === "string" && p.endsWith(".app")) out[id] = p;
  }
  return out;
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const current = await loadConfig();

    const updated: AppConfig = {
      codeDirectories: body.codeDirectories ?? current.codeDirectories,
      editor: body.editor ?? current.editor,
      gitGui: body.gitGui ?? current.gitGui,
      browser: body.browser ?? current.browser,
      notifications: body.notifications ?? current.notifications,
      notificationSound: body.notificationSound ?? current.notificationSound,
      alwaysNotify: body.alwaysNotify ?? current.alwaysNotify,
      terminalApp: body.terminalApp ?? current.terminalApp,
      terminalOpenIn: body.terminalOpenIn ?? current.terminalOpenIn,
      terminalUseTmux: body.terminalUseTmux ?? current.terminalUseTmux,
      terminalTmuxMode: body.terminalTmuxMode ?? current.terminalTmuxMode,
      initialCommand: body.initialCommand !== undefined ? body.initialCommand : current.initialCommand,
      initialPrompt: body.initialPrompt !== undefined ? body.initialPrompt : current.initialPrompt,
      createPrPrompt: body.createPrPrompt !== undefined ? body.createPrPrompt : current.createPrPrompt,
      defaultBaseBranch: body.defaultBaseBranch ?? current.defaultBaseBranch,
      showKeyboardHints: body.showKeyboardHints !== undefined ? body.showKeyboardHints : current.showKeyboardHints,
      staleThresholdMinutes:
        typeof body.staleThresholdMinutes === "number" && body.staleThresholdMinutes >= 5
          ? Math.floor(body.staleThresholdMinutes)
          : current.staleThresholdMinutes,
      cleanupCloseTabs: body.cleanupCloseTabs ?? current.cleanupCloseTabs,
      editorAppPaths: sanitizeAppPaths(body.editorAppPaths) ?? current.editorAppPaths,
    };

    await saveConfig(updated);
    return NextResponse.json({ config: updated });
  } catch (error) {
    console.error("Failed to save settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
