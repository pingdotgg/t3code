import * as os from "node:os";
import * as path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { type ProviderRuntimeEvent, ThreadId } from "@forma/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(currentDir, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const grokAdapterTestLayer = it.layer(
  makeGrokAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "forma-grok-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

grokAdapterTestLayer("GrokAdapterLive", (it) => {
  it.effect("emits agentResult text when xAI prompt completion has no streamed chunks", () =>
    Effect.gen(function* () {
      const adapter = yield* GrokAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("grok-xai-agent-result-text");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_XAI_PROMPT_COMPLETE_AGENT_RESULT_JSON: JSON.stringify({
            message: {
              content: [{ type: "text", text: "hello from xai agent result" }],
            },
          }),
        }),
      );
      yield* settings.updateSettings({ providers: { grok: { binaryPath: wrapperPath } } });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "grok",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "grok", model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise xai agent result fallback",
        attachments: [],
        modelSelection: { provider: "grok", model: "grok-build" },
      });

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);

      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join("");
      const contentIndex = runtimeEvents.findIndex(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      const completedIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      assert.equal(content, "hello from xai agent result");
      assert.isAtLeast(contentIndex, 0);
      assert.isAtLeast(completedIndex, 0);
      assert.isBelow(contentIndex, completedIndex);

      yield* adapter.stopSession(threadId);
    }),
  );
});
