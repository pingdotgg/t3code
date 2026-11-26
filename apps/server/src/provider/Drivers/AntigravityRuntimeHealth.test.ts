import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

const dependencies = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-runtime-health-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(dependencies),
);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const makeHarness = Effect.fn("AntigravityRuntimeHealthTest.makeHarness")(function* (
  source: "path" | "override",
  symlink: boolean,
  threadLauncher = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const environment = yield* HostProcess.Environment;
  const agent = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-executable-" });
  const executable = path.join(root, "agy");
  const target = path.join(root, "runtime");
  const versionFile = path.join(root, "version");
  const writeRuntime = (file: string, version: string) =>
    fs
      .writeFileString(
        file,
        [
          "#!/bin/sh",
          ...(threadLauncher
            ? [
                `if [ -n "$T3CODE_THREAD_ID" ]; then export T3_ACP_AGENT_VERSION=1.5.12; exec ${shellQuote(node)} ${shellQuote(agent)} "$@"; fi`,
              ]
            : []),
          `export T3_ACP_AGENT_VERSION=${version === "variable" ? `$(cat ${shellQuote(versionFile)})` : shellQuote(version)}`,
          `exec ${shellQuote(node)} ${shellQuote(agent)} "$@"`,
          "",
        ].join("\n"),
      )
      .pipe(Effect.andThen(fs.chmod(file, 0o755)));
  const initialTarget = symlink ? path.join(root, "original-runtime") : executable;
  yield* writeRuntime(initialTarget, "variable");
  yield* fs.writeFileString(versionFile, "1.5.12");
  if (symlink) yield* fs.symlink(initialTarget, executable);

  const installation = yield* AntigravityInstallation.makeAntigravityInstallation({
    baseDir: root,
    releaseAsset: null,
    updateChecksEnabled: Effect.succeed(false),
  });
  const instance = yield* AntigravityDriver.create({
    instanceId: ProviderInstanceId.make(path.basename(root)),
    displayName: "Antigravity",
    enabled: true,
    config: {
      ...AntigravityDriver.defaultConfig(),
      ...(source === "override" ? { binaryPath: executable } : {}),
    },
    environment: [
      { name: "PATH", value: `${root}:${environment.PATH ?? ""}`, sensitive: false },
      { name: "T3_ACP_ANTIGRAVITY", value: "1", sensitive: false },
    ],
  }).pipe(Effect.provideService(AntigravityInstallation.AntigravityInstallation, installation));
  if (!instance.refreshModels) return yield* Effect.die("Antigravity model refresh is missing");
  return {
    fs,
    executable,
    target,
    versionFile,
    writeRuntime,
    refresh: instance.refreshModels,
    check: instance.snapshot.refresh,
    instance,
    root,
  };
});

it.layer(layerTest)("external Antigravity runtime health", (it) => {
  for (const [source, upgrade] of [
    ["path", "in-place upgrade"],
    ["override", "symlink retarget"],
    ["path", "compatible handshake"],
    ["path", "handshake without a version"],
  ] as const) {
    const expectedStatus = upgrade === "handshake without a version" ? "error" : "ready";
    it.effect.skipIf(windowsHost)(`reports ${expectedStatus} for ${source} after ${upgrade}`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(source, upgrade === "symlink retarget");
        yield* h.refresh();
        yield* h.fs.writeFileString(h.versionFile, "1.5.0");
        const refused = yield* h.refresh().pipe(Effect.flip);
        expect(yield* h.check).toMatchObject({
          status: "error",
          version: "1.5.0",
          message: refused.detail,
        });
        if (upgrade === "in-place upgrade") {
          yield* h.writeRuntime(h.executable, "1.5.12");
        } else if (upgrade === "symlink retarget") {
          yield* h.writeRuntime(h.target, "variable");
          yield* h.fs.remove(h.executable);
          yield* h.fs.symlink(h.target, h.executable);
          yield* h.fs.writeFileString(h.versionFile, "1.5.12");
        } else {
          yield* h.fs.writeFileString(
            h.versionFile,
            upgrade === "compatible handshake" ? "1.5.12" : "",
          );
          yield* h.refresh();
        }
        const snapshot = yield* h.check;
        expect(snapshot.status).toBe(expectedStatus);
        if (upgrade === "in-place upgrade" || upgrade === "symlink retarget") {
          expect(snapshot.version).toBeNull();
        }
        if (upgrade === "handshake without a version") {
          expect(snapshot).toMatchObject({ version: "1.5.0", message: refused.detail });
        }
      }),
    );
  }

  it.effect.skipIf(windowsHost)(
    "keeps the provider refusal after the launcher works in a thread",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("override", false, true);
        yield* h.refresh();
        yield* h.fs.writeFileString(h.versionFile, "1.5.0");
        const refused = yield* h.refresh().pipe(Effect.flip);

        const threadId = ThreadId.make("antigravity-runtime-health-thread");
        const providerSessionId = ProviderSessionId.make("antigravity-runtime-health-session");
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("antigravity-runtime-health-environment"),
          threadId,
          providerSessionId,
          providerInstanceId: h.instance.instanceId,
          endpoint: "http://127.0.0.1:43126/mcp",
          authorizationHeader: "Bearer fixture",
          browserToolsAvailable: false,
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: h.root,
        });
        const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId,
              modelSelection,
              runtimePolicy,
            });
            yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
          }),
        );

        expect(yield* h.check).toMatchObject({
          status: "error",
          version: "1.5.0",
          message: refused.detail,
        });
      }),
  );
});
