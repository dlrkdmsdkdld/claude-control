"use client";

import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import type { SessionHost } from "@/lib/types";

const iconBtnClass =
  "flex items-center justify-center h-8 rounded-lg bg-white/4 hover:bg-white/10 border border-white/7 hover:border-white/15 text-zinc-500 hover:text-zinc-200 transition-all duration-150";

function IconButton({
  onClick,
  tip,
  className,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  tip: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} className={`has-tooltip ${className || iconBtnClass}`} data-tip={tip} aria-label={tip}>
      {children}
    </button>
  );
}

const prIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
    />
  </svg>
);

export function QuickActions({
  path,
  pid,
  targetScreen,
  status,
  prUrl,
  orphaned,
  tmuxSession,
  onCleanup,
  host,
  acceptsInput = true,
  canOpenConversation = false,
  editorWorkspace,
  sharedProcess = false,
}: {
  path: string;
  pid?: number | null;
  targetScreen?: number | null;
  status?: string;
  prUrl?: string | null;
  orphaned?: boolean;
  tmuxSession?: string | null;
  onCleanup?: (e: React.MouseEvent) => void;
  host?: SessionHost;
  /** Whether typed input (Create PR prompt) can reach the session */
  acceptsInput?: boolean;
  canOpenConversation?: boolean;
  editorWorkspace?: string | null;
  /** The process hosts other conversations too (Codex app-server) — no end-session button */
  sharedProcess?: boolean;
}) {
  const [actionError, setActionError] = useState<{ error: string; hint?: string; tone?: "info" } | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [killArmed, setKillArmed] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const showError = (err: { error: string; hint?: string; tone?: "info" }) => {
    setActionError(err);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setActionError(null), 10000);
  };

  /** POST an action and surface the server's error + hint instead of swallowing it. */
  const postAction = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch("/api/actions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
        showError({ error: data.error ?? `실행 실패 (${res.status})`, hint: data.hint });
        return false;
      }
      setActionError(null);
      return true;
    } catch (err) {
      showError({ error: "Claude Control 서버에 연결하지 못했습니다.", hint: String(err) });
      return false;
    }
  };
  const [prSending, setPrSending] = useState(false);
  const [killing, setKilling] = useState(false);

  const killSession = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pid) return;
    // Two-step: the first click only arms the button, so it can't be mistaken for a window switch
    if (!killArmed) {
      setKillArmed(true);
      setTimeout(() => setKillArmed(false), 4000);
      return;
    }
    setKillArmed(false);
    setKilling(true);
    try {
      // Live sessions: close the hosting tab/pane; orphaned ones have no tab, so just end the process
      const res = await fetch("/api/sessions/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid, closeTab: !orphaned }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) showError({ error: data.error ?? `종료 실패 (${res.status})` });
      else if (data.message) showError({ error: data.message, tone: "info" });
    } catch (err) {
      console.error("Kill failed:", err);
    }
    // Reset after 3s in case session doesn't disappear immediately
    setTimeout(() => setKilling(false), 3000);
  };

  const [reattaching, setReattaching] = useState(false);

  const reattachSession = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!tmuxSession) return;
    setReattaching(true);
    try {
      await fetch("/api/sessions/reattach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmuxSession, cwd: path }),
      });
    } catch (err) {
      console.error("Reattach failed:", err);
    }
    setTimeout(() => setReattaching(false), 3000);
  };

  const { editorAvailable, gitGuiAvailable, editorId, editorLabel, gitGuiLabel, quickOpenEditors } = useSettings();

  const openAction = async (e: React.MouseEvent, action: string, extra: Record<string, unknown> = {}) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    await postAction({ action, path, pid, targetScreen: targetScreen ?? undefined, ...extra });
  };

  const isVSCodeHost = host?.kind === "vscode-extension" || host?.kind === "vscode-terminal";
  const workspaceName = (editorWorkspace ?? path).split("/").filter(Boolean).pop() ?? path;
  const focusTip = !host
    ? "터미널 창으로 이동"
    : host.kind === "vscode-extension"
      ? `VS Code 창으로 이동 (${workspaceName}) — 프로젝트 창만 앞으로 가져옵니다`
      : host.kind === "vscode-terminal"
        ? `VS Code 창으로 이동 (${workspaceName}, 통합 터미널)`
        : host.kind === "app"
          ? `${host.appName ?? "앱"}(으)로 전환`
          : host.kind === "tmux"
            ? "터미널 창으로 이동 (tmux)"
            : `터미널 창으로 이동 (${host.appName ?? "Terminal"})`;
  const showFocus = !!pid && host?.kind !== "unknown";
  // Alternatives to the default editor, shown in the "다른 앱으로 열기" menu
  const menuEditors = quickOpenEditors.filter((ed) => ed.id !== editorId || !editorAvailable);

  const sendCreatePR = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pid) return;
    setPrSending(true);
    try {
      // Load the configured create-PR prompt
      const settingsRes = await fetch("/api/settings");
      const settings = await settingsRes.json();
      const message = settings.config?.createPrPrompt || "/create-pr";

      await postAction({ action: "send-message", path, pid, message });
    } catch (err) {
      console.error("Send PR message failed:", err);
    }
    setTimeout(() => setPrSending(false), 2000);
  };

  const openPrUrl = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!prUrl) return;
    try {
      await fetch("/api/actions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open-url", url: prUrl }),
      });
    } catch {
      // Fallback
      window.open(prUrl, "_blank");
    }
  };

  const showPRButton = pid && acceptsInput && (status === "idle" || status === "waiting");

  // Ends the claude process (SIGTERM, then SIGKILL). Two clicks so it can't be
  // mistaken for a window switch.
  const killButton = (
    <IconButton
      onClick={killSession}
      tip={
        killing
          ? "종료하는 중..."
          : killArmed
            ? orphaned
              ? "한 번 더 클릭하면 이 claude 프로세스를 종료합니다"
              : "한 번 더 클릭하면 이 세션의 탭을 닫습니다"
            : orphaned
              ? "세션 종료 — 연결이 끊긴 claude 프로세스를 종료 (화면 전환 아님)"
              : "세션 종료 — 이 세션이 실행 중인 탭/창만 닫음 (앱 전체는 유지)"
      }
      className={`flex-1 flex items-center justify-center h-8 rounded-lg ${
        killing || killArmed
          ? "bg-orange-500/10 border-orange-500/20 text-orange-400"
          : "bg-white/4 hover:bg-orange-500/12 border border-white/7 hover:border-orange-500/25 text-zinc-500 hover:text-orange-400"
      } transition-all duration-150`}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
      </svg>
    </IconButton>
  );

  return (
    <div className="w-full">
      <div className="flex items-center gap-1.5 w-full">
        {/* PR button: grey to send /create-pr, green if PR exists (links to it) */}
        {prUrl ? (
          <IconButton
            onClick={openPrUrl}
            tip="PR 페이지 열기 (브라우저)"
            className="flex-1 flex items-center justify-center h-8 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/22 border border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400 hover:text-emerald-300 transition-all duration-150"
          >
            {prIcon}
          </IconButton>
        ) : showPRButton ? (
          <IconButton
            onClick={sendCreatePR}
            tip={prSending ? "요청을 보냈습니다" : "Create PR — Claude에게 커밋·푸시·PR 생성을 요청 (화면 전환 아님)"}
            className={`flex-1 flex items-center justify-center h-8 rounded-lg border transition-all duration-150 ${
              prSending
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : "bg-white/4 hover:bg-white/10 border-white/7 hover:border-white/15 text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {prIcon}
          </IconButton>
        ) : null}

        {pid && orphaned ? (
          <>
            {tmuxSession && (
              <IconButton
                onClick={reattachSession}
                tip={reattaching ? "다시 연결하는 중..." : "tmux 세션을 새 터미널에 다시 연결"}
                className={`flex-1 flex items-center justify-center h-8 rounded-lg ${
                  reattaching
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    : "bg-white/4 hover:bg-emerald-500/12 border border-white/7 hover:border-emerald-500/25 text-zinc-500 hover:text-emerald-400"
                } transition-all duration-150`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 15l6-6m-5.5.5h.01m4.99 5h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </IconButton>
            )}
            {killButton}
          </>
        ) : showFocus ? (
          <IconButton onClick={(e) => openAction(e, "focus")} tip={focusTip} className={`flex-1 ${iconBtnClass}`}>
            {isVSCodeHost ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 6A2.25 2.25 0 016 3.75h12A2.25 2.25 0 0120.25 6v12A2.25 2.25 0 0118 20.25H6A2.25 2.25 0 013.75 18V6zM3.75 8.25h16.5M7.5 6h.008v.008H7.5V6zm2.25 0h.008v.008H9.75V6z"
                />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
                />
              </svg>
            )}
          </IconButton>
        ) : null}
        {pid && canOpenConversation && host?.kind === "vscode-extension" && (
          <IconButton
            onClick={(e) => openAction(e, "open-conversation")}
            tip="VS Code에서 이 대화 탭 열기 (확장 URI 사용)"
            className={`flex-1 ${iconBtnClass}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
              />
            </svg>
          </IconButton>
        )}
        {(editorAvailable || menuEditors.length > 0) && (
          <div className="relative flex-1 flex" ref={menuRef}>
            {editorAvailable && (
              <IconButton
                onClick={(e) => openAction(e, "editor")}
                tip={`${editorLabel}(으)로 프로젝트 폴더 열기 (기본 에디터)`}
                className={`flex-1 ${iconBtnClass} ${menuEditors.length > 0 ? "rounded-r-none" : ""}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
                  />
                </svg>
              </IconButton>
            )}
            {menuEditors.length > 0 && (
              <IconButton
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen((o) => !o);
                }}
                tip="다른 앱으로 프로젝트 열기"
                className={`${editorAvailable ? "w-6 rounded-l-none border-l-0" : "flex-1"} ${iconBtnClass}`}
              >
                {editorAvailable ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
                    />
                  </svg>
                )}
              </IconButton>
            )}
            {menuOpen && (
              <div
                className="absolute bottom-full right-0 mb-1.5 z-30 min-w-[180px] rounded-lg border border-white/10 bg-zinc-900 shadow-xl py-1"
                onClick={(e) => e.stopPropagation()}
              >
                {menuEditors.map((ed) => (
                  <button
                    key={ed.id}
                    onClick={(e) => openAction(e, "editor", { editorId: ed.id })}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/8 hover:text-white"
                  >
                    {ed.label}로 열기
                  </button>
                ))}
                <p className="px-3 pt-1 pb-0.5 text-[10px] text-zinc-600 border-t border-white/5 mt-1">
                  이 카드의 폴더를 엽니다. 이미 열린 창이 있으면 재사용합니다.
                </p>
              </div>
            )}
          </div>
        )}
        {gitGuiAvailable && (
          <IconButton
            onClick={(e) => openAction(e, "git-gui")}
            tip={`${gitGuiLabel}에서 저장소 열기`}
            className={`flex-1 ${iconBtnClass}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 3v12m0 0a3 3 0 103 3H15a3 3 0 100-3H9a3 3 0 01-3-3zm0 0a3 3 0 103-3 3 3 0 00-3 3z"
              />
            </svg>
          </IconButton>
        )}
        <IconButton
          onClick={(e) => openAction(e, "finder")}
          tip="Finder에서 폴더 열기"
          className={`flex-1 ${iconBtnClass}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
            />
          </svg>
        </IconButton>
        {/* Codex app-servers host other conversations — only terminal Codex can be ended here */}
        {pid && !orphaned && !sharedProcess && killButton}
        {onCleanup && (
          <IconButton
            onClick={onCleanup}
            tip="정리 — worktree와 세션을 삭제 (확인 후 실행)"
            className={`flex-1 flex items-center justify-center h-8 rounded-lg bg-white/3 hover:bg-red-500/12 border border-white/5 hover:border-red-500/25 text-zinc-600 hover:text-red-400 transition-all duration-150`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
              />
            </svg>
          </IconButton>
        )}
      </div>
      {actionError && (
        <div
          role="alert"
          onClick={(e) => {
            e.stopPropagation();
            setActionError(null);
          }}
          className={`mt-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed cursor-pointer ${
            actionError.tone === "info" ? "border-white/10 bg-white/4" : "border-red-500/20 bg-red-500/8"
          }`}
        >
          <p className={actionError.tone === "info" ? "text-zinc-300" : "text-red-300"}>{actionError.error}</p>
          {actionError.hint && <p className="text-zinc-400 mt-0.5">{actionError.hint}</p>}
        </div>
      )}
    </div>
  );
}
