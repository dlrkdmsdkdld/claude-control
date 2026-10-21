import { NextResponse } from "next/server";
import { isClaudeProcess } from "@/lib/process-utils";
import { closeSessionTab, findLiveSession } from "@/lib/session-actions";

export async function POST(request: Request) {
  try {
    const { pid, closeTab } = (await request.json()) as { pid: number; closeTab?: boolean };

    if (!pid || typeof pid !== "number") {
      return NextResponse.json({ error: "Missing or invalid pid" }, { status: 400 });
    }

    const session = await findLiveSession(pid);

    // A Codex app-server (VS Code extension, ChatGPT app) hosts other
    // conversations too — never end it. Terminal Codex TUIs are fine.
    if (session?.sharedProcess) {
      return NextResponse.json(
        {
          error:
            "이 Codex 세션은 다른 대화와 프로세스를 공유하므로 여기서 종료할 수 없습니다. 해당 앱에서 닫아 주세요.",
        },
        { status: 409 },
      );
    }

    // Close the tab/pane hosting the session (never the whole app)
    if (closeTab && session) {
      const result = await closeSessionTab(session);
      return NextResponse.json({ ok: true, ...result });
    }

    if (!(await isClaudeProcess(pid))) {
      return NextResponse.json({ error: "PID is not a claude process" }, { status: 403 });
    }

    try {
      process.kill(pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    } catch {
      // Process doesn't exist or already dead — that's fine
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
