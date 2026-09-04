import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderInstanceId,
  type AntigravitySettings,
} from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
  type AntigravityExecutable,
} from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityProfileDirectory,
} from "../antigravityAuthSupport.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

const hostPlatform = HostProcessPlatform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: { readonly config?: Partial<AntigravitySettings> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcessExecutablePath;
  const baseEnv = yield* HostProcessEnvironment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const profileDirectory = resolveAntigravityProfileDirectory(config.stateDir, instanceId);
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    loginRequired = false,
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy_acp_server.par");
    const harnessPath = path.join(directory, "localharness_external");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(harnessPath, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(executablePath, 0o755);
    yield* fs.chmod(harnessPath, 0o755);
    return {
      executablePath,
      harnessPath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityExecutable;
  });

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", true);
  const controls = { selected: first, failResolution: false, beforeAcquire: Effect.void };
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const installation = Layer.mock(AntigravityInstallation)({
    managedDirectory: root,
    acquire: (binaryPath, environment) =>
      Effect.gen(function* () {
        acquisitions.push({ binaryPath, path: environment?.PATH });
        yield* controls.beforeAcquire;
        if (controls.failResolution) {
          return yield* new AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        const selected = controls.selected;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(selected.version);
          }),
        );
        return selected;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      launches.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        profileDirectory: environment.GEMINI_HOME,
        harnessPath: environment.ANTIGRAVITY_HARNESS_PATH,
        forceFileStorage: environment.AGY_ACP_FORCE_FILE_STORAGE,
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: environment.GEMINI_API_KEY,
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: false,
    config: { ...AntigravityDriver.defaultConfig(), ...options.config },
    environment: [
      { name: "PATH", value: instancePath },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "ANTIGRAVITY_HARNESS_PATH", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(installation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      // Cancelled startup can report a signal instead of a numeric exit code.
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
    }
  });
  return {
    instance,
    refresh,
    fs,
    profileDirectory,
    instancePath,
    first,
    second,
    signedOut,
    controls,
    acquisitions,
    releases,
    launches,
    readRequests,
    assertClosed,
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ModelManifest.layerTest),
);

it.layer(testLayer)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)("does not launch a process for a disabled instance", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const snapshot = yield* h.instance.snapshot.refresh;
      expect(snapshot.status).toBe("disabled");
      expect(h.acquisitions).toEqual([]);
      expect(h.launches).toEqual([]);
      expect(yield* h.fs.exists(h.profileDirectory)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("refreshes models after slow process startup", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      h.controls.beforeAcquire = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(ready)),
      );
      const refresh = yield* h.refresh().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("70 seconds");
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(refresh);
      const snapshot = yield* h.instance.snapshot.getSnapshot;
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(0);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "refreshes a disabled instance through the selected executable and personal Google ACP",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        // The mock catalog is not in the manifest's current list, so it folds
        // under the legacy section like an old Codex model would.
        expect(snapshot.models.every((model) => model.isLegacy === true)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        h.controls.selected = h.second;
        yield* h.refresh();

        expect(h.acquisitions).toEqual([
          { binaryPath: "", path: h.instancePath },
          { binaryPath: "", path: h.instancePath },
        ]);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.command)).toEqual([
          h.first.executablePath,
          h.second.executablePath,
        ]);
        expect(nativeLaunches.map((launch) => launch.harnessPath)).toEqual([
          h.first.harnessPath,
          h.second.harnessPath,
        ]);
        for (const launch of nativeLaunches) {
          expect(launch.args).toEqual(hostPlatform === "linux" ? ["--uid="] : []);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
        }
        for (const launch of h.launches) expect(launch.credentialKeys).toEqual([]);
        expect(h.releases).toEqual([h.first.version, h.second.version]);
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "authenticate",
          "session/new",
          "initialize",
          "authenticate",
          "session/new",
        ]);
        expect(
          requests
            .filter((request) => request.method === "authenticate")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "authenticates with the configured API key method and labels the account by method",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          config: { authMethod: "gemini-api-key", apiKey: "fixture-gemini-key" },
        });
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth).toMatchObject({
          status: "authenticated",
          type: "gemini-api-key",
          label: "Gemini API key",
        });
        expect(snapshot.models.length).toBeGreaterThan(0);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.geminiApiKey)).toEqual(["fixture-gemini-key"]);
        const requests = yield* h.readRequests;
        expect(
          requests
            .filter((request) => request.method === "authenticate")
            .map((request) => request.params?.methodId),
        ).toEqual(["gemini-api-key"]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("reports the missing credential before launching a process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ config: { authMethod: "gemini-api-key" } });
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("API key");
      expect(h.launches.filter((launch) => launch.harnessPath !== undefined)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.acquisitions).toHaveLength(2);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "clears account metadata when a text helper needs Google sign-in",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.profileDirectory,
            message: "Repair Google login",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TextGenerationError");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when executable resolution fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      h.controls.failResolution = true;
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.acquisitions).toHaveLength(2);
      expect(h.releases).toEqual([h.first.version]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );
});
