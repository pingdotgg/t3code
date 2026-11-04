// @effect-diagnostics-next-line nodeBuiltinImport:off -- the native SDK callback reads the child fixture's account outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { claudeCliFixtureSource } from "../ClaudeCliAuth.testkit.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
const parseAccount = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ email: Schema.String })),
);

const layerDeps = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-" }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ServerSettings.layerTest(),
  ModelManifest.layerTest,
  ResetCreditCoordinator.layerTest,
  ProviderLatestVersions.layer,
  Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({}),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Fixture must not send HTTP")),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerTest = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    return ProviderHost.ProviderHost.of({
      paths: config,
      settings: {
        get: settings.getSettings,
        withSnapshot: settings.withSettingsSnapshot,
        changes: settings.streamChanges,
        subscribe: settings.subscribeChanges,
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("Native Claude owns its credentials"),
    });
  }),
).pipe(Layer.provideMerge(layerDeps));

it.effect(
  "invalidates the populated Claude account cache after native sign-in and guards text generation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-driver-binary-" });
      const binaryPath = path.join(root, "claude");
      yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${claudeCliFixtureSource}`, {
        mode: 0o755,
      });
      const instanceId = ProviderInstanceId.make("private");
      const configDir = path.join(stateDir, "providers", "claude", instanceId, "cli");
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "account.json"),
        '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"before@example.test"}',
      );
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: async () => {
              const account = parseAccount(
                await NodeFSP.readFile(path.join(configDir, "account.json"), "utf8"),
              );
              return {
                commands: [],
                agents: [],
                models: [],
                output_style: "default",
                available_output_styles: [],
                account: {
                  email: account.email,
                  subscriptionType: "pro",
                  tokenSource: "oauth",
                  apiProvider: "firstParty",
                },
              };
            },
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: false,
              rate_limits: null,
            }),
          }) as unknown as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const instance = yield* ClaudeDriver.create({
        instanceId,
        enabled: true,
        displayName: "Private",
        environment: [
          { name: "T3_TEST_EMAIL", value: "after@example.test", sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value: path.join(root, "shared"), sensitive: false },
        ],
        config: {
          ...ClaudeDriver.defaultConfig(),
          setupMode: "cli",
          binaryPath,
          shareProfile: false,
        },
      });
      expect((yield* instance.snapshot.refresh).auth.email).toBe("before@example.test");
      expect((yield* instance.snapshot.refresh).auth.email).toBe("before@example.test");
      const auth = instance.auth!;
      yield* auth.start("owner");
      const waiting = yield* auth.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "waiting"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(
        (yield* instance.textGeneration
          .generateThreadTitle({
            cwd: root,
            message: "Title",
            modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          })
          .pipe(Effect.flip)).detail,
      ).toBe("Provider sign-in is changing. Try again after it finishes.");
      const refreshed = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.auth.email === "after@example.test"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkScoped,
      );
      yield* auth.complete!("owner", { flowId: waiting.flowId!, callbackUrl: "fixture-code" });
      expect((yield* Fiber.join(refreshed)).auth).toMatchObject({
        status: "authenticated",
        email: "after@example.test",
      });
      expect(query.mock.calls).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

for (const conflict of [false, true]) {
  it.effect.skipIf(!symlinksSupported)(
    `materializes the profile at create with conflict=${conflict}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-driver-overlay-" });
        const shared = path.join(root, "shared");
        const instanceId = ProviderInstanceId.make("overlay");
        const account = path.join(stateDir, "providers", "claude", instanceId, "cli");
        yield* fs.makeDirectory(shared);
        if (conflict) {
          yield* fs.makeDirectory(account, { recursive: true });
          yield* fs.writeFileString(path.join(account, "settings.json"), "account");
        }
        const create = ClaudeDriver.create({
          instanceId,
          enabled: false,
          displayName: "Overlay",
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: shared, sensitive: false }],
          config: { ...ClaudeDriver.defaultConfig(), setupMode: "cli" },
        });
        if (conflict) {
          const error = yield* create.pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "ProviderDriverError" });
          expect(error.detail).toContain(path.join(account, "settings.json"));
          expect(yield* fs.readFileString(path.join(account, "settings.json"))).toBe("account");
        } else {
          const instance = yield* create;
          expect(yield* fs.readLink(path.join(account, "settings.json"))).toBe(
            path.join(shared, "settings.json"),
          );
          expect(instance.continuationIdentity.continuationKey).toBe(`claude:home:${account}`);
          expect(instance.auth?.credentialBinding).toEqual({ owner: "provider", key: account });
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
