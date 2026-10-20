import { findTerminalInTree } from "./terminal/detect";
import type { ProcessTreeEntry } from "./terminal/types";
import type { SessionHost } from "./types";

/** VS Code–family editors, keyed by main executable name inside the .app bundle. */
const VSCODE_FAMILY: Record<string, { appName: string; uriScheme: string }> = {
  Code: { appName: "Visual Studio Code", uriScheme: "vscode" },
  "Code - Insiders": { appName: "Visual Studio Code - Insiders", uriScheme: "vscode-insiders" },
  Cursor: { appName: "Cursor", uriScheme: "cursor" },
  Windsurf: { appName: "Windsurf", uriScheme: "windsurf" },
  VSCodium: { appName: "VSCodium", uriScheme: "vscodium" },
};

/** Outermost .app bundle in an executable path, or null. */
export function appBundleFromComm(comm: string): string | null {
  const idx = comm.indexOf(".app/");
  if (idx === -1) return comm.endsWith(".app") ? comm : null;
  return comm.slice(0, idx + 4);
}

function basename(p: string): string {
  return p.includes("/") ? p.split("/").pop() || p : p;
}

/**
 * Describe what a claude process runs under, by walking its ancestors.
 *
 * - VS Code extension: the CLI reports entrypoint "claude-vscode" (or, for
 *   older builds, has no TTY and sits under "Code Helper (Plugin)").
 * - VS Code integrated terminal: has a TTY and sits under "Code Helper".
 * - Known terminal emulators: as detected by findTerminalInTree.
 * - Any other .app ancestor (GitKraken, IDEs…): a GUI app hosts it.
 */
export function detectSessionHost(
  pid: number,
  processTree: Map<number, ProcessTreeEntry>,
  opts: { entrypoint: string | null; hasTty: boolean; tmuxSession: string | null },
): SessionHost {
  if (opts.tmuxSession) {
    return { kind: "tmux", appName: "tmux", bundlePath: null, uriScheme: null };
  }

  let vscodeBundle: { bundle: string; exe: string; viaPluginHost: boolean } | null = null;
  let firstApp: string | null = null;
  let current = processTree.get(pid)?.ppid ?? 0;
  let sawPluginHost = false;
  const visited = new Set<number>();
  while (current > 1 && !visited.has(current)) {
    visited.add(current);
    const entry = processTree.get(current);
    if (!entry) break;
    if (entry.comm.includes("Code Helper (Plugin)") || entry.comm.includes("Helper (Plugin)")) sawPluginHost = true;
    const bundle = appBundleFromComm(entry.comm);
    if (bundle) {
      firstApp ??= bundle;
      const exe = basename(entry.comm);
      if (VSCODE_FAMILY[exe] && entry.comm === `${bundle}/Contents/MacOS/${exe}`) {
        vscodeBundle = { bundle, exe, viaPluginHost: sawPluginHost };
        break;
      }
    }
    current = entry.ppid;
  }

  if (vscodeBundle) {
    const family = VSCODE_FAMILY[vscodeBundle.exe];
    const isExtension =
      opts.entrypoint === "claude-vscode" || (opts.entrypoint === null && !opts.hasTty && vscodeBundle.viaPluginHost);
    return {
      kind: isExtension ? "vscode-extension" : "vscode-terminal",
      appName: family.appName,
      bundlePath: vscodeBundle.bundle,
      uriScheme: family.uriScheme,
    };
  }

  const term = findTerminalInTree(pid, processTree);
  if (term.app !== "unknown") {
    return { kind: "terminal", appName: term.appName, bundlePath: null, uriScheme: null };
  }

  if (firstApp) {
    const appName = basename(firstApp).replace(/\.app$/, "");
    return { kind: "app", appName, bundlePath: firstApp, uriScheme: null };
  }

  return { kind: "unknown", appName: null, bundlePath: null, uriScheme: null };
}

/**
 * Whether typed input (Create PR prompt, quick replies) can be delivered to the
 * session. Only terminals with an adapter (and tmux send-keys) qualify — VS Code
 * extension sessions talk to the extension over stdio, and typing into an
 * editor window via System Events would land in whatever has focus.
 */
export function hostAcceptsTerminalInput(host: SessionHost): boolean {
  return host.kind === "terminal" || host.kind === "tmux";
}
