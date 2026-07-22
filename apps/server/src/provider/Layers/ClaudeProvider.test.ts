import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

type ClaudeQuery = typeof import("@anthropic-ai/claude-agent-sdk").query;
type ClaudeInitialization = Awaited<ReturnType<ReturnType<ClaudeQuery>["initializationResult"]>>;

const claudeQueryMock = vi.hoisted(() => vi.fn());
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeQueryMock,
}));

beforeEach(() => {
  claudeQueryMock.mockReset();
});

it.layer(NodeServices.layer)("probeClaudeCapabilities", (it) => {
  it.effect("keeps completed probes when another custom model times out", () =>
    Effect.gen(function* () {
      let activeProbes = 0;
      let peakActiveProbes = 0;
      const closedModels: Array<string> = [];

      claudeQueryMock.mockImplementation((input: Parameters<ClaudeQuery>[0]) => {
        assert.ok(input.options);
        assert.ok(input.options.abortController);
        const model = input.options.model ?? "default";
        const abort = input.options.abortController;
        activeProbes += 1;
        peakActiveProbes = Math.max(peakActiveProbes, activeProbes);
        let closed = false;
        const close = () => {
          if (!closed) {
            closed = true;
            activeProbes -= 1;
            closedModels.push(model);
          }
        };

        const initializationResult = () => {
          if (model === "slow") {
            return new Promise<ClaudeInitialization>((_resolve, reject) => {
              abort.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
          }
          return Promise.resolve({
            account: { email: `${model}@example.com` },
            commands: [],
            models: [
              {
                value: model,
                displayName: model,
                description: "Custom model",
                supportsEffort: true,
                supportedEffortLevels: ["low", "high"],
              },
            ],
          } as unknown as ClaudeInitialization);
        };

        return { close, initializationResult } as ReturnType<ClaudeQuery>;
      });

      const settings = yield* decodeClaudeSettings({
        customModels: ["slow", "fast", "later"],
      });
      const probe = yield* probeClaudeCapabilities(settings).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      while (claudeQueryMock.mock.calls.length < 3) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("25 seconds");

      const result = yield* Fiber.join(probe);
      assert.deepStrictEqual(result?.models.map((model) => model.value).toSorted(), [
        "fast",
        "later",
      ]);
      assert.strictEqual(result?.email, "fast@example.com");
      assert.strictEqual(peakActiveProbes, 2);
      assert.strictEqual(activeProbes, 0);
      assert.deepStrictEqual(closedModels.toSorted(), ["fast", "later", "slow"]);
    }),
  );
});
