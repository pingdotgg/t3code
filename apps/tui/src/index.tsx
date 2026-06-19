import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./app.tsx";
import { buildTuiRuntime, makeTuiClient, type TuiOptions } from "./connection.ts";

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

const mintSocketUrl = (): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const send = process.send as ((message: unknown) => boolean) | undefined;
    if (typeof send !== "function") {
      reject(new Error("no IPC channel to the t3 parent process"));
      return;
    }
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    send.call(process, { type: "mintSocketUrl", id });
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
  const client = makeTuiClient(runtime);

  // Render on a transparent background so the user's terminal theme (and its own
  // background colour) shows through instead of OpenTUI's opaque default.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: "transparent" });

  // Detect the terminal's actual palette + default fg/bg up front, so our indexed
  // and default colour intents resolve to the user's real theme (not a fallback
  // palette) even on truecolor terminals. Best-effort: themes that don't answer
  // the OSC query just keep the conventional ANSI mapping.
  await renderer.getPalette({ timeout: 250 }).catch(() => {});
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const handleExit = () => {
    try {
      renderer.destroy();
    } catch {
      // best effort — destroy restores the terminal
    }
    resolveDone();
  };

  createRoot(renderer).render(<App client={client} onExit={handleExit} />);

  await done;
  await client.dispose();
}

main().catch((error) => {
  process.stderr.write(`t3 tui crashed: ${String(error)}\n`);
  process.exitCode = 1;
});
