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
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath];

describe("AcpSessionRuntime on-demand authentication", () => {
  it.effect("skips authenticate during start and authenticates on first prompt failure", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];

    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.sessionId).toBe("mock-session-1");

      const promptError = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.flip);

      expect(promptError._tag).toBe("AcpRequestError");

      const methods = requestEvents.map((event) => event.method);
      // With on-demand auth, start() must not call authenticate.
      expect(methods.indexOf("authenticate")).toBeGreaterThan(methods.indexOf("session/new"));

      // The authenticate request must have been issued after the failed prompt.
      const authenticateEvents = requestEvents.filter(
        (event) => event.method === "authenticate" && event.status === "started",
      );
      expect(authenticateEvents.length).toBe(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              T3_ACP_FAIL_PROMPT: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
          authenticationMode: "on-demand",
          isAuthenticationFailure: () => true,
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
