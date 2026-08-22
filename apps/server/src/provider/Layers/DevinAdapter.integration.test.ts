// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DevinSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

async function makeDelayedCompactMockDevin(delayMs = 1500) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-devin.sh");
  const script = `#!/bin/sh
export T3_ACP_EMIT_DELAYED_COMPACT_COMPLETION=1
export T3_ACP_DELAYED_COMPACT_COMPLETION_MS=${delayMs}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("keeps /compact running until its delayed terminal update is rendered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-delayed-compact");
      const wrapperPath = yield* Effect.promise(() => makeDelayedCompactMockDevin());
      const adapter = yield* makeDevinAdapter(
        decodeDevinSettings({ binaryPath: wrapperPath }),
      ).pipe(Effect.orDie);
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter
        .sendTurn({ threadId, input: "/compact", attachments: [] })
        .pipe(Effect.timeout("5 seconds"));

      const finalChunkIndex = events.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "acted",
      );
      const completionIndex = events.findIndex((event) => event.type === "turn.completed");
      const session = (yield* adapter.listSessions()).find(
        (candidate) => String(candidate.threadId) === String(threadId),
      );

      expect(finalChunkIndex).toBeGreaterThanOrEqual(0);
      expect(completionIndex).toBeGreaterThan(finalChunkIndex);
      expect(session?.status).toBe("ready");
      expect(session?.activeTurnId).toBeUndefined();

      yield* Fiber.interrupt(eventFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("lets Stop cancel a background compact without leaving sendTurn hung", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-cancel-delayed-compact");
      const wrapperPath = yield* Effect.promise(() => makeDelayedCompactMockDevin(30_000));
      const adapter = yield* makeDevinAdapter(
        decodeDevinSettings({ binaryPath: wrapperPath }),
      ).pipe(Effect.orDie);
      const compactStarted = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "content.delta" && event.payload.delta.includes("Compacting context")
              ? Deferred.succeed(compactStarted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "/compact", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(compactStarted).pipe(Effect.timeout("3 seconds"));
      yield* adapter.interruptTurn(threadId, undefined).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendFiber).pipe(Effect.timeout("2 seconds"));

      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      expect(completions[0]?.payload.state).toBe("cancelled");

      yield* Fiber.interrupt(eventFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
