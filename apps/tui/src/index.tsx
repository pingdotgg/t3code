import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { ChatView } from "./components/ChatView.tsx";
import { buildTuiRuntime, makeTuiClient, type TuiOptions } from "./connection.ts";
import { applyTerminalColors } from "./theme.ts";

// This is the Bun entry point spawned by the Node `t3 tui` command. It receives
// the server origin + a bearer token via env, and mints fresh websocket URLs by
// asking the parent (which holds EnvironmentAuth) over the Node IPC channel —
// the parent stays alive for the whole session and answers each request.

interface SocketUrlReply {
  readonly type: "socketUrl";
  readonly id: number;
  readonly url: string | null;
  readonly error?: string;
}

let nextRequestId = 1;
const pending = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>();

process.on("message", (raw: unknown) => {
  if (typeof raw !== "object" || raw === null) return;
  const message = raw as Partial<SocketUrlReply>;
  if (message.type !== "socketUrl" || typeof message.id !== "number") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (typeof message.url === "string") entry.resolve(message.url);
  else entry.reject(new Error(message.error ?? "failed to mint socket url"));
});

// If the parent goes away mid-request, settle outstanding mints instead of
// leaving them (and the reconnect loop that awaits them) hung forever.
process.on("disconnect", () => {
  for (const entry of pending.values()) {
    entry.reject(new Error("t3 parent IPC channel closed"));
  }
  pending.clear();
});

const mintSocketUrl = (): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const send = process.send as ((message: unknown) => boolean) | undefined;
    if (typeof send !== "function") {
      reject(new Error("no IPC channel to the t3 parent process"));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("timed out minting a websocket url"));
    }, 10_000);
    timer.unref?.();
    pending.set(id, {
      resolve: (url) => {
        clearTimeout(timer);
        resolve(url);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      send.call(process, { type: "mintSocketUrl", id });
    } catch (error) {
      if (pending.delete(id)) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

async function main(): Promise<void> {
  const origin = process.env.T3_TUI_ORIGIN;
  const bearerToken = process.env.T3_TUI_BEARER;
  const logPath = process.env.T3_TUI_LOG ?? "/tmp/t3-tui.log";
  if (!origin || !bearerToken) {
    process.stderr.write("t3 tui: missing T3_TUI_ORIGIN / T3_TUI_BEARER\n");
    process.exitCode = 1;
    return;
  }

  const options: TuiOptions = { origin, bearerToken, mintSocketUrl, logPath };
  const runtime = buildTuiRuntime(options);
  const client = makeTuiClient(runtime, origin);

  // Render on a transparent background so the user's terminal theme (and its own
  // background colour) shows through instead of OpenTUI's opaque default.
  // `enableMouseMovement: false` requests basic mouse reporting (clicks + wheel)
  // without motion tracking. That leaves the terminal's own drag-selection (and
  // copy-on-select, e.g. Ghostty's) working on the rendered text — the same way
  // the prompt copies — instead of OpenTUI capturing the drag for its own
  // selection. Our UI only needs clicks and wheel scroll, so nothing is lost.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: "transparent",
    enableMouseMovement: false,
  });

  try {
    // Detect the terminal's actual palette + default fg/bg up front and feed it into
    // the theme, so our indexed/default colour intents render with the user's REAL
    // colours instead of OpenTUI's built-in (darker) xterm fallback. Best-effort:
    // terminals that don't answer the OSC query keep the conventional ANSI mapping.
    const detectedColors = await renderer.getPalette({ timeout: 1000 }).catch(() => null);
    if (detectedColors) applyTerminalColors(detectedColors);
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let exiting = false;
    const handleExit = () => {
      if (exiting) return;
      exiting = true;
      try {
        renderer.destroy();
      } catch {
        // best effort — destroy restores the terminal
      }
      resolveDone();
    };

    // Raw mode usually delivers Ctrl+C as a keystroke (handled in <App/>), but some
    // terminals/multiplexers send a real signal — handle both so one press quits.
    process.once("SIGINT", handleExit);
    process.once("SIGTERM", handleExit);

    createRoot(renderer).render(<ChatView client={client} onExit={handleExit} />);

    await done;
  } catch (error) {
    // Restore the terminal before the error propagates — otherwise it's left in
    // raw/alt-screen mode with a garbled message.
    try {
      renderer.destroy();
    } catch {
      // best effort
    }
    throw error;
  }
  // The renderer is already torn down (handleExit). Dispose the RPC runtime, then
  // force-exit: the live WebSocket and the IPC channel to the parent would
  // otherwise keep Bun's event loop alive, so a single Ctrl+C wouldn't fully quit.
  await Promise.race([
    client.dispose().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 300)),
  ]);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`t3 tui crashed: ${String(error)}\n`);
  process.exit(1);
});
