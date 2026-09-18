import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { OpenCodeDriver } from "./OpenCodeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-workspace-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No external HTTP expected")),
    ),
  ),
);

it.layer(testLayer)("OpenCode workspace discovery", (it) => {
  it.effect("fails a broken command request and discovers commands on retry", () =>
    Effect.gen(function* () {
      let failing = true;
      const client = createOpencodeClient({
        baseUrl: "http://opencode.test",
        throwOnError: true,
        fetch: Object.assign(
          async () =>
            failing
              ? Response.json({ message: "temporarily unavailable" }, { status: 503 })
              : Response.json([
                  {
                    name: "review",
                    description: "Review this workspace",
                    hints: [],
                    template: "private",
                  },
                ]),
          { preconnect: () => undefined },
        ),
      });
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-workspace"),
        displayName: "OpenCode test",
        enabled: true,
        environment: [],
        config: { ...OpenCodeDriver.defaultConfig(), serverUrl: "http://opencode.test" },
      }).pipe(
        Effect.provide(
          Layer.mock(OpenCodeRuntime)({
            connectToOpenCodeServer: () =>
              Effect.succeed({
                url: "http://opencode.test",
                version: "1.18.0",
                exitCode: null,
                external: true,
              }),
            createOpenCodeSdkClient: () => client,
            loadOpenCodeSkills: () => Effect.succeed([]),
          }),
        ),
      );
      expect(instance.snapshotForCwd).toBeDefined();
      const failed = yield* instance.snapshotForCwd!("/workspace").pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      failing = false;
      const recovered = yield* instance.snapshotForCwd!("/workspace");
      expect(recovered.slashCommands.some((command) => command.name === "review")).toBe(true);
    }).pipe(Effect.scoped),
  );
});
