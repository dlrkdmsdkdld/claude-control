import { execFile } from "child_process";
import { promisify } from "util";
import { EDITOR_OPTIONS, loadConfig } from "./config";
import { discoverSessions } from "./discovery";
import { openInEditor, readBundleExecutable } from "./editor-launcher";
import { findTabShell, readConversationTitle, windowShowsConversation } from "./session-close";
import { buildProcessTree, closeSession, detectAllTmuxPanes, detectTerminal, getTtysForPids } from "./terminal";
import { getAdapter } from "./terminal/adapters";
import type { ClaudeSession } from "./types";
import { conversationUri } from "./vscode";

const execFileAsync = promisify(execFile);
const VSCODE_DEF = EDITOR_OPTIONS.find((e) => e.id === "vscode")!;
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Look the session up server-side so host/app paths never come from the client. */
export async function findLiveSession(pid: number): Promise<ClaudeSession | null> {
  const sessions = await discoverSessions();
  return sessions.find((s) => s.pid === pid) ?? null;
}

/** Bring the VS Code window that hosts the session to the front (reusing it). */
export async function focusEditorWindow(session: ClaudeSession) {
  const folder = session.editorWorkspace ?? session.workingDirectory;
  const config = await loadConfig();
  const tree = await buildProcessTree();
  return openInEditor(VSCODE_DEF, folder, {
    overridePath: config.editorAppPaths?.vscode,
    processTree: tree,
    preferBundle: session.host.bundlePath,
  });
}

/** Reveal the session's conversation tab in its VS Code window. */
export async function revealConversation(session: ClaudeSession) {
  const opened = await focusEditorWindow(session);
  await new Promise((r) => setTimeout(r, 700));
  const uri = conversationUri(session.host.uriScheme ?? "vscode", session.id);
  await execFileAsync("open", opened.bundlePath ? ["-a", opened.bundlePath, uri] : [uri], { timeout: 10000 });
  return opened;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

/** SIGTERM, then SIGKILL if the process is still alive after a second. */
async function terminate(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (!(await waitForExit(pid, 1000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export interface CloseResult {
  /** "tab": the tab/pane/window was closed; "process": only the claude process was ended */
  closed: "tab" | "process";
  message: string;
}

/**
 * End a session by closing the tab that hosts it — never the whole app.
 * - Terminals with tab control (iTerm2, Terminal, WezTerm, kitty) and tmux: close that tab/pane.
 * - VS Code extension: reveal the conversation tab and press ⌘W, but only after
 *   the window title confirms that tab is active; otherwise end the process only.
 * - Other hosts (VS Code / IDE / GitKraken terminals…): end the tab's shell, which
 *   closes or ends the tab depending on the app's settings.
 * The claude process is always confirmed gone at the end.
 */
export async function closeSessionTab(session: ClaudeSession): Promise<CloseResult> {
  const pid = session.pid!;
  let result: CloseResult;

  if (session.host.kind === "terminal" || session.host.kind === "tmux") {
    const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
    const info = await detectTerminal(pid, tree, panes);
    if (info.inTmux || getAdapter(info.app)?.closeSession) {
      // End claude first so the terminal doesn't ask "terminate running processes?"
      await terminate(pid);
      try {
        await closeSession(info);
        result = {
          closed: "tab",
          message: info.inTmux ? "tmux pane을 닫았습니다." : `${info.appName} 탭을 닫았습니다.`,
        };
      } catch {
        result = {
          closed: "process",
          message: `${info.appName} 탭을 정확히 확인하지 못해 탭은 닫지 않고 claude 프로세스만 종료했습니다.`,
        };
      }
    } else {
      result = await endTabShell(pid, tree, session.host.appName);
    }
  } else if (session.host.kind === "vscode-extension") {
    result = await closeVSCodeConversation(session);
  } else {
    result = await endTabShell(pid, await buildProcessTree(), session.host.appName);
  }

  if (!(await waitForExit(pid, 2000))) await terminate(pid);
  return result;
}

async function endTabShell(
  pid: number,
  tree: Awaited<ReturnType<typeof buildProcessTree>>,
  appName: string | null,
): Promise<CloseResult> {
  const shell = findTabShell(pid, tree);
  if (shell !== null) {
    // Only signal a shell on the same terminal as claude — never an unrelated process
    const ttys = await getTtysForPids([pid, shell]);
    if (ttys.get(pid) && ttys.get(pid) === ttys.get(shell)) {
      try {
        process.kill(shell, "SIGHUP");
        return {
          closed: "tab",
          message: `${appName ?? "터미널"} 탭의 셸을 종료했습니다. 탭이 남아 있으면 앱 설정에 따라 직접 닫아 주세요.`,
        };
      } catch {
        // fall through to ending claude only
      }
    }
  }
  await terminate(pid);
  return { closed: "process", message: "탭을 특정할 수 없어 claude 프로세스만 종료했습니다." };
}

async function closeVSCodeConversation(session: ClaudeSession): Promise<CloseResult> {
  const pid = session.pid!;
  const title = await readConversationTitle(session.jsonlPath);
  if (!session.canOpenConversation || !SESSION_UUID_RE.test(session.id) || !title) {
    await terminate(pid);
    return {
      closed: "process",
      message: "이 대화 탭을 확인할 수 없어 claude 프로세스만 종료했습니다. VS Code 탭은 직접 닫아 주세요.",
    };
  }

  const opened = await revealConversation(session);
  await new Promise((r) => setTimeout(r, 800));
  const exe = (opened.bundlePath && (await readBundleExecutable(opened.bundlePath))) || "Code";
  let windowTitle = "";
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", `tell application "System Events" to tell process "${exe}" to get name of front window`],
      { timeout: 5000 },
    );
    windowTitle = stdout.trim();
  } catch {
    await terminate(pid);
    return {
      closed: "process",
      message:
        "VS Code 창 제목을 읽지 못해(손쉬운 사용 권한 필요) claude 프로세스만 종료했습니다. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 Claude Control을 허용하면 탭도 닫을 수 있습니다.",
    };
  }

  if (!windowShowsConversation(windowTitle, title)) {
    await terminate(pid);
    return {
      closed: "process",
      message: `활성 탭이 이 대화("${title}")인지 확인되지 않아 탭은 닫지 않고 claude 프로세스만 종료했습니다.`,
    };
  }

  await execFileAsync(
    "osascript",
    ["-e", `tell application "System Events" to tell process "${exe}" to keystroke "w" using command down`],
    { timeout: 5000 },
  );
  return { closed: "tab", message: `VS Code의 "${title}" 대화 탭을 닫았습니다.` };
}
