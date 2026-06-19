import { buildTuiRuntime, makeTuiClient, type TuiOptions } from "./connection.ts";
import { runTuiApp } from "./app.tsx";

export type { TuiOptions } from "./connection.ts";

/**
 * Entry point for the terminal UI. The host (the server CLI) does the loopback
 * auth bootstrap and hands us a ready-to-use {@link TuiOptions}: the server
 * origin, a bearer token, and a `mintSocketUrl` that returns a freshly-ticketed
 * websocket URL. We build the Effect runtime + RPC client and run the Ink app.
 */
export async function runTui(options: TuiOptions): Promise<void> {
  const runtime = buildTuiRuntime(options);
  const client = makeTuiClient(runtime);
  try {
    await runTuiApp(client);
  } finally {
    await client.dispose();
  }
}
