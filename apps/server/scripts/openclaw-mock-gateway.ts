#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
//
// openclaw-mock-gateway.ts — a scripted stand-in for the `openclaw gateway`
// binary used by the OpenClaw runtime tests. The real OpenClaw gateway is not
// installed in CI or on contributor machines, so the spawn-path tests launch
// this script through a tiny shell wrapper and drive it through the same
// WebSocket protocol the runtime speaks to a real gateway.
//
// It accepts the real CLI shape (`gateway --port <port> --allow-unconfigured`)
// and honors `OPENCLAW_GATEWAY_TOKEN`, delegating the protocol handling to
// {@link ../src/provider/testUtils/openclawMockGateway}.
//
// Behavior is selected with T3_OPENCLAW_* environment variables; unset flags
// produce the happy-path gateway.

import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  let port = 18_789;
  if (portIndex >= 0 && args[portIndex + 1]) {
    port = Number(args[portIndex + 1]);
  }
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;

  // Resolve the testUtils module relative to this script. When spawned via
  // the tsx/vite transform the import graph resolves through the server src
  // tree; fall back to a direct file URL when the package mapping is absent.
  let startMock: typeof import("../src/provider/testUtils/openclawMockGateway.ts").startMockOpenClawGateway;
  try {
    ({ startMockOpenClawGateway: startMock } =
      await import("../src/provider/testUtils/openclawMockGateway.ts"));
  } catch {
    ({ startMockOpenClawGateway: startMock } = await import(
      NodeURL.pathToFileURL(
        NodePath.join(__dirname, "..", "src", "provider", "testUtils", "openclawMockGateway.ts"),
      ).href
    ));
  }

  const handle = await startMock({
    port,
    ...(token !== undefined ? { token } : {}),
    serverVersion: "2026.8.1-mock",
    emitThinking: process.env.T3_OPENCLAW_EMIT_THINKING === "1",
    emitToolEvents: process.env.T3_OPENCLAW_EMIT_TOOL_EVENTS === "1",
    emitApproval: process.env.T3_OPENCLAW_EMIT_APPROVAL === "1",
  });
  // The gateway listens on the requested port; the mock bound to an ephemeral
  // port, so log the real one on a line the runtime can parse if needed.
  console.log(`mock openclaw gateway listening on ${handle.port}`);
  const onSignal = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
}

main().catch((error) => {
  console.error(`mock openclaw gateway error: ${String(error)}`);
  process.exit(1);
});
