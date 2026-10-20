import { NextResponse } from "next/server";
import { isClaudeProcess } from "@/lib/process-utils";
import { closeSessionTab, findLiveSession } from "@/lib/session-actions";

export async function POST(request: Request) {
  try {
    const { pid, closeTab } = (await request.json()) as { pid: number; closeTab?: boolean };

    if (!pid || typeof pid !== "number") {
      return NextResponse.json({ error: "Missing or invalid pid" }, { status: 400 });
    }

    if (!(await isClaudeProcess(pid))) {
      return NextResponse.json({ error: "PID is not a claude process" }, { status: 403 });
    }

    // Close the tab/pane hosting the session (never the whole app)
    if (closeTab) {
      const session = await findLiveSession(pid);
      if (session) {
        const result = await closeSessionTab(session);
        return NextResponse.json({ ok: true, ...result });
      }
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
