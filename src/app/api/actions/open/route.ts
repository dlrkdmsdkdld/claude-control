import { exec, execFile } from "child_process";
import { stat } from "fs/promises";
import { NextResponse } from "next/server";
import { promisify } from "util";
import { CHROMIUM_BROWSERS } from "@/lib/close-tabs";
import { BROWSER_OPTIONS, EDITOR_OPTIONS, GIT_GUI_OPTIONS, loadConfig } from "@/lib/config";
import { LaunchError, openInEditor } from "@/lib/editor-launcher";
import { findLiveSession, focusEditorWindow, revealConversation, SESSION_UUID_RE } from "@/lib/session-actions";
import {
  buildProcessTree,
  detectAllTmuxPanes,
  detectTerminal,
  focusSession,
  sendKeystroke,
  sendText,
} from "@/lib/terminal";
import { escapeForAppleScript } from "@/lib/terminal/adapters/shared";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

type ActionType =
  | "focus"
  | "iterm"
  | "editor"
  | "finder"
  | "git-gui"
  | "send-message"
  | "send-keystroke"
  | "open-url"
  | "open-conversation";

function failure(error: string, hint: string, status = 422, attempts: string[] = []) {
  return NextResponse.json({ error, hint, attempts }, { status });
}

/**
 * Move the frontmost window of an app to a target screen.
 * screenIndex 0 = primary/main screen, 1 = secondary, etc.
 */
async function moveAppToScreen(appName: string, screenIndex: number): Promise<void> {
  const script = `
use framework "AppKit"

set screens to current application's NSScreen's screens()
set screenCount to count of screens

if ${screenIndex} >= screenCount then
  return "no screen"
end if

-- Get target screen frame: frame() returns {{originX, originY}, {width, height}}
set targetScreen to item (${screenIndex} + 1) of screens
set f to targetScreen's frame()
set sx to item 1 of item 1 of f as integer
set sy to item 2 of item 1 of f as integer
set sw to item 1 of item 2 of f as integer
set sh to item 2 of item 2 of f as integer

-- Primary screen height for coordinate conversion (NSScreen is bottom-left origin, AppleScript is top-left)
set pf to (item 1 of screens)'s frame()
set primaryHeight to item 2 of item 2 of pf as integer
set asY to primaryHeight - sy - sh

-- Move the frontmost window of the app to the target screen
tell application "${appName}"
  if (count of windows) > 0 then
    set bounds of front window to {sx + 50, asY + 50, sx + sw - 50, asY + sh - 50}
  end if
end tell

return "ok"
`;

  try {
    await execAsync(`osascript -l AppleScript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 });
  } catch {
    // Silently fail — window positioning is best-effort
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, path, pid, targetScreen, message, url, keystroke, editorId } = body as {
      editorId?: string;
      action: ActionType;
      path?: string;
      pid?: number;
      targetScreen?: number;
      message?: string;
      url?: string;
      keystroke?: string;
    };

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    // "iterm" is accepted as backward compat for "focus"
    const normalizedAction = action === "iterm" ? "focus" : action;

    if (
      normalizedAction !== "focus" &&
      normalizedAction !== "send-message" &&
      normalizedAction !== "send-keystroke" &&
      normalizedAction !== "open-url" &&
      normalizedAction !== "open-conversation"
    ) {
      if (!path) {
        return NextResponse.json({ error: "Missing path" }, { status: 400 });
      }
      try {
        await stat(path);
      } catch {
        return failure(`폴더가 존재하지 않습니다: ${path}`, "worktree가 삭제됐거나 경로가 이동됐을 수 있습니다.", 404);
      }
    }

    // Which launch path succeeded (reported back for diagnostics)
    let launchMethod: string | undefined;

    switch (normalizedAction) {
      case "focus": {
        if (!pid) {
          return NextResponse.json({ error: "Missing pid for focus action" }, { status: 400 });
        }
        const session = await findLiveSession(pid);
        if (!session) return failure("세션 프로세스를 찾을 수 없습니다.", "세션이 이미 종료됐을 수 있습니다.", 404);
        if (session.host.kind === "vscode-extension" || session.host.kind === "vscode-terminal") {
          launchMethod = (await focusEditorWindow(session)).method;
          break;
        }
        if (session.host.kind === "app" && session.host.bundlePath) {
          await execFileAsync("open", ["-a", session.host.bundlePath], { timeout: 10000 });
          break;
        }
        if (session.host.kind === "unknown") {
          return failure(
            "이 세션을 실행 중인 터미널 창을 찾지 못했습니다.",
            "터미널이 닫혔거나 지원하지 않는 앱에서 실행 중입니다. tmux 세션이면 Reattach를 사용하세요.",
          );
        }
        const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
        const info = await detectTerminal(pid, tree, panes);
        await focusSession(info);
        break;
      }
      case "editor": {
        const config = await loadConfig();
        const editorDef = EDITOR_OPTIONS.find((e) => e.id === (editorId ?? config.editor));
        if (!editorDef || !editorDef.appName) {
          return failure(
            "기본 에디터가 설정돼 있지 않습니다.",
            "Settings → Tools → Code Editor에서 에디터를 선택하세요.",
            400,
          );
        }
        const tree = await buildProcessTree();
        const opened = await openInEditor(editorDef, path!, {
          overridePath: config.editorAppPaths?.[editorDef.id],
          processTree: tree,
        });
        launchMethod = opened.method;
        if (targetScreen !== undefined) {
          await new Promise((r) => setTimeout(r, 800));
          await moveAppToScreen(editorDef.appName, targetScreen);
        }
        break;
      }
      case "open-conversation": {
        if (!pid) return NextResponse.json({ error: "Missing pid" }, { status: 400 });
        const session = await findLiveSession(pid);
        if (!session) return failure("세션 프로세스를 찾을 수 없습니다.", "세션이 이미 종료됐을 수 있습니다.", 404);
        if (
          session.host.kind !== "vscode-extension" ||
          !session.canOpenConversation ||
          !SESSION_UUID_RE.test(session.id)
        ) {
          return failure(
            "이 세션은 VS Code 대화 탭 열기를 지원하지 않습니다.",
            "VS Code 확장 세션이 아니거나, 설치된 Claude Code 확장이 대화 열기 URI를 지원하지 않습니다. 'VS Code 창으로 이동'을 사용하세요.",
          );
        }
        // Focus the hosting window first: the extension handles the URI in the
        // active window, revealing the tab if that window holds the conversation.
        launchMethod = (await revealConversation(session)).method;
        break;
      }
      case "finder":
        await execFileAsync("open", [path!]);
        if (targetScreen !== undefined) {
          await new Promise((r) => setTimeout(r, 500));
          await moveAppToScreen("Finder", targetScreen);
        }
        break;
      case "git-gui": {
        const gitConfig = await loadConfig();
        const guiDef = GIT_GUI_OPTIONS.find((g) => g.id === gitConfig.gitGui);
        if (!guiDef || !guiDef.appName) {
          return NextResponse.json({ error: "No git GUI configured" }, { status: 400 });
        }
        await execFileAsync("open", ["-a", guiDef.appName, path!]);
        if (targetScreen !== undefined) {
          await new Promise((r) => setTimeout(r, 800));
          await moveAppToScreen(guiDef.appName, targetScreen);
        }
        break;
      }
      case "send-message": {
        if (!pid) {
          return NextResponse.json({ error: "Missing pid for send-message action" }, { status: 400 });
        }
        if (!message) {
          return NextResponse.json({ error: "Missing message" }, { status: 400 });
        }
        const target = await findLiveSession(pid);
        if (target && !target.acceptsInput) {
          return failure(
            "이 세션에는 메시지를 보낼 수 없습니다.",
            "VS Code 확장 등 터미널이 아닌 환경의 세션입니다. 해당 앱에서 직접 입력하세요.",
            409,
          );
        }
        const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
        const info = await detectTerminal(pid, tree, panes);
        await sendText(info, message);
        break;
      }
      case "send-keystroke": {
        if (!pid) {
          return NextResponse.json({ error: "Missing pid for send-keystroke action" }, { status: 400 });
        }
        if (!keystroke) {
          return NextResponse.json({ error: "Missing keystroke" }, { status: 400 });
        }
        const target = await findLiveSession(pid);
        if (target && !target.acceptsInput) {
          return failure(
            "이 세션에는 키 입력을 보낼 수 없습니다.",
            "VS Code 확장 등 터미널이 아닌 환경의 세션입니다. 해당 앱에서 직접 승인·거절하세요.",
            409,
          );
        }
        const [tree, panes] = await Promise.all([buildProcessTree(), detectAllTmuxPanes()]);
        const info = await detectTerminal(pid, tree, panes);
        await sendKeystroke(info, keystroke);
        break;
      }
      case "open-url": {
        if (!url) {
          return NextResponse.json({ error: "Missing url" }, { status: 400 });
        }
        const browserConfig = await loadConfig();
        const browserDef = BROWSER_OPTIONS.find((b) => b.id === browserConfig.browser) ?? BROWSER_OPTIONS[0];
        const escapedUrl = escapeForAppleScript(url);

        if (CHROMIUM_BROWSERS.includes(browserDef.appName)) {
          const script = `
tell application "${browserDef.appName}"
  set found to false
  repeat with aWindow in windows
    set tabIndex to 0
    repeat with aTab in tabs of aWindow
      set tabIndex to tabIndex + 1
      if URL of aTab starts with "${escapedUrl}" then
        set active tab index of aWindow to tabIndex
        set index of aWindow to 1
        activate
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
  if not found then
    activate
    open location "${escapedUrl}"
  end if
end tell`;
          try {
            await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
          } catch {
            await execFileAsync("open", ["-a", browserDef.appName, url]);
          }
        } else {
          await execFileAsync("open", ["-a", browserDef.appName, url]);
        }
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, method: launchMethod });
  } catch (error) {
    if (error instanceof LaunchError) {
      return failure(error.message, error.hint, 422, error.attempts);
    }
    console.error("Action failed:", error instanceof Error ? error.message : error);
    const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return failure(`실행에 실패했습니다: ${msg}`, "앱 설치 위치와 권한을 확인하세요.", 500);
  }
}
