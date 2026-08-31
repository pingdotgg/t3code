/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 vp test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes ACP CLI probe", () => {
  it.effect("completes a real Hermes turn through the provider adapter", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-live-probe");
      const adapter = yield* makeHermesAdapter(
        decodeHermesSettings({ enabled: true, binaryPath: "hermes" }),
      );
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
        },
      });
      expect(session.provider).toBe("hermes");

      yield* adapter.sendTurn({
        threadId,
        input: "Reply with only T3_HERMES_OK.",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const output = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      expect(output).toContain("T3_HERMES_OK");
      expect(events.at(-1)?.type).toBe("turn.completed");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
