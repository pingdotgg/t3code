// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const startWithRequestLog = (authMethodId: string | undefined) => {
  const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
  return Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
    yield* runtime.start();
    return requestEvents;
  }).pipe(
    Effect.provide(
      AcpSessionRuntime.layer({
        spawn: { command: "node", args: [mockAgentPath] },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        ...(authMethodId !== undefined ? { authMethodId } : {}),
        requestLogger: (event) =>
          Effect.sync(() => {
            requestEvents.push(event);
          }),
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );
};

describe("AcpSessionRuntime authenticate", () => {
  it.effect("sends authenticate when authMethodId is provided", () =>
    Effect.map(startWithRequestLog("test"), (requestEvents) => {
      expect(requestEvents.some((event) => event.method === "authenticate")).toBe(true);
    }),
  );

  it.effect("skips authenticate when authMethodId is omitted", () =>
    Effect.map(startWithRequestLog(undefined), (requestEvents) => {
      expect(requestEvents.some((event) => event.method === "authenticate")).toBe(false);
      expect(requestEvents.some((event) => event.method === "initialize")).toBe(true);
    }),
  );
});
