import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type AntigravitySettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
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
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    /** Extra instance variables, such as ones a parent T3 turn already exported. */
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  // Each agent start appends its runtime name, so tests see which `agy` PATH resolved to.
  const runLog = path.join(root, "runs.log");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instanceBin = path.join(root, "instance-bin");
  const agyOnPath = path.join(instanceBin, "agy");
  yield* fs.makeDirectory(instanceBin, { recursive: true });
  // No inherited PATH: an `agy` installed on the test machine must not answer for the fixture.
  const instancePath = `${instanceBin}:/usr/bin:/bin`;

  /** An `agy` CLI build; `use` puts it on the instance PATH. */
  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    options: {
      readonly version?: string;
      readonly loginRequired?: boolean;
      /** `data` of the agent's "Internal error" response to `session/new`. */
      readonly newSessionErrorData?: unknown;
      readonly initialMode?: string;
    } = {},
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    const version = options.version ?? "1.5.13";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then printf '%s\\n' ${shellQuote(version)}; exit 0; fi`,
        `printf '%s\\n' ${shellQuote(name)} >> ${shellQuote(runLog)}`,
        ...(options.loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        ...(options.newSessionErrorData === undefined
          ? []
          : [
              `export T3_ACP_NEW_SESSION_ERROR_DATA=${shellQuote(JSON.stringify(options.newSessionErrorData))}`,
            ]),
        ...(options.initialMode === undefined
          ? []
          : [`export T3_ACP_INITIAL_MODE=${shellQuote(options.initialMode)}`]),
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(executablePath, 0o755);
    return { name, version, executablePath };
  });
  type Executable = Effect.Success<ReturnType<typeof makeExecutable>>;

  /** Removes `agy` from the instance PATH, as before Orbit installs it. */
  const removeCli = fs.remove(agyOnPath, { force: true });
  /** Re-points `agy` on the instance PATH, as an Orbit install or update does. */
  const use = (executable: Executable) =>
    removeCli.pipe(Effect.andThen(fs.symlink(executable.executablePath, agyOnPath)));

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", { loginRequired: true });
  yield* use(first);
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    environment: Record<string, string | undefined>;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    tempDirectory: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      const env = (name: string) => {
        const value = environment[name];
        return Redacted.isRedacted(value) ? Redacted.value(value) : value;
      };
      const args = command.args.map(String);
      launches.push({
        command: command.command,
        args,
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        environment: Object.fromEntries(Object.keys(environment).map((name) => [name, env(name)])),
        profileDirectory: env("GEMINI_HOME"),
        harnessPath: env("ANTIGRAVITY_HARNESS_PATH"),
        forceFileStorage: env("AGY_ACP_FORCE_FILE_STORAGE"),
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        tempDirectory: args[0] === "acp" ? env("TMPDIR") : undefined,
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
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
      ...(options.environment ?? []),
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner));
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  // The first health check loads the account and models; tests count what follows it.
  const firstCheck = yield* instance.snapshot.refresh;
  const checkLaunches = launches.length;
  yield* fs.remove(requestLog, { force: true });
  yield* fs.remove(runLog, { force: true });
  const readLines = (file: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return [];
      return (yield* fs.readFileString(file)).split(/\r?\n/u).filter(Boolean);
    });
  const readRequests = readLines(requestLog).pipe(
    Effect.flatMap((lines) => Effect.forEach(lines, (line) => decodeRequest(line))),
  );
  /** Runtime names of the agents started so far, in order. */
  const readRuns = readLines(runLog);
  /** ACP agent starts after the first health check; `agy --version` checks are left out. */
  const agentLaunches = () =>
    launches.slice(checkLaunches).filter((launch) => launch.args[0] === "acp");
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    firstCheck,
    refresh,
    makeExecutable,
    use,
    removeCli,
    agyOnPath,
    fs,
    path,
    profileDirectory,
    directories,
    instancePath,
    first,
    second,
    signedOut,
    launches,
    agentLaunches,
    readRequests,
    readRuns,
    assertClosed,
  };
});

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected quota request")),
    ),
  ),
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
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "refreshes the selected executable and limits form capabilities to chat",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(snapshot.models.every((model) => model.isLegacy !== true)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        yield* h.use(h.second);
        yield* h.refresh();

        // `agy` is looked up on the instance PATH before every start, so the new build runs.
        expect(yield* h.readRuns).toEqual([h.first.name, h.second.name]);
        const versionChecks = h.launches.filter((launch) => launch.args[0] === "--version");
        expect(versionChecks.length).toBeGreaterThan(0);
        for (const launch of versionChecks) {
          expect(launch.command).toBe(h.agyOnPath);
          expect(launch.environment.PATH).toBe(h.instancePath);
        }
        const agentLaunches = h.agentLaunches();
        expect(agentLaunches).toHaveLength(2);
        for (const launch of agentLaunches) {
          expect(launch.command).toBe(h.agyOnPath);
          expect(launch.args).toEqual([
            "acp",
            "--gemini-dir",
            h.profileDirectory,
            "--app-data-dir",
            "antigravity-acp",
          ]);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.harnessPath).toBeUndefined();
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
          expect(launch.credentialKeys).toEqual([]);
        }
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "auth/login",
          "session/new",
          "initialize",
          "auth/login",
          "session/new",
        ]);
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
        yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.profileDirectory,
            message: "Name this thread",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.ignore);
        const workspace = yield* h.fs.makeTempDirectoryScoped({ prefix: "t3-ag-chat-" });
        const threadId = ThreadId.make("thread-antigravity-capabilities");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
        const session = yield* h.instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-capabilities"),
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });

        const helper = {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { notices: {}, compaction: {} },
        };
        expect(
          (yield* h.readRequests)
            .filter((request) => request.method === "initialize")
            .map((request) => request.params?.clientCapabilities),
        ).toEqual([
          // Two model refreshes, then thread title generation.
          helper,
          helper,
          helper,
          {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            session: { notices: {}, compaction: {} },
            elicitation: { form: {} },
          },
        ]);

        // The agy CLI rejects `yolo` and `auto_edit`; it stays in `default` and T3 answers its requests.
        yield* h.use(yield* h.makeExecutable("runtime cli", { initialMode: "auto_edit" }));
        for (const runtimeMode of ["full-access", "auto-accept-edits"] as const) {
          const requestsBefore = (yield* h.readRequests).length;
          const cliThreadId = ThreadId.make(`thread-antigravity-cli-${runtimeMode}`);
          const cliPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: workspace,
          });
          const cliSession = yield* h.instance.orchestrationAdapter.openSession({
            threadId: cliThreadId,
            providerSessionId: ProviderSessionId.make(`provider-session-cli-${runtimeMode}`),
            modelSelection,
            runtimePolicy: cliPolicy,
          });
          yield* cliSession.ensureThread({
            threadId: cliThreadId,
            modelSelection,
            runtimePolicy: cliPolicy,
          });
          expect(h.agentLaunches().at(-1)?.args).toEqual([
            "acp",
            "--gemini-dir",
            h.profileDirectory,
            "--app-data-dir",
            "antigravity-acp",
          ]);
          expect(
            (yield* h.readRequests)
              .slice(requestsBefore)
              .filter(
                (request) =>
                  request.method === "session/set_config_option" &&
                  request.params?.configId === "mode",
              )
              .map((request) => request.params?.value),
          ).toEqual(["default"]);
        }
      }),
  );

  it.effect.skipIf(windowsHost)(
    "gives a thread session its own T3 thread and MCP fallback environment",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          environment: [
            { name: "T3CODE_THREAD_ID", value: "thread-antigravity-ambient" },
            { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:9/ambient" },
            { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer ambient-token" },
            { name: "T3_ACP_MCP_NODE", value: "/ambient/node" },
            { name: "T3_ACP_MCP_ENTRYPOINT", value: "/ambient/entrypoint.mjs" },
          ],
        });
        yield* h.refresh();
        const endpoint = "http://127.0.0.1:43126/mcp";
        const threadId = ThreadId.make("thread-antigravity-process-environment");
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-antigravity-process-environment"),
          threadId,
          providerSessionId: "mcp-session-antigravity-process-environment",
          providerInstanceId: h.instance.instanceId,
          endpoint,
          authorizationHeader: "Bearer antigravity-thread-token",
          browserToolsAvailable: false,
        });
        // Running from source, the fallback entrypoint is this process's script.
        const entrypoint = h.path.resolve(process.argv[1]!);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* h.fs.makeTempDirectoryScoped({ prefix: "t3-ag-environment-" });
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: workspace,
            });
            const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
            const session = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(
                "provider-session-antigravity-process-environment",
              ),
              modelSelection,
              runtimePolicy,
            });
            yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
          }),
        );

        // Gemini Enterprise can strip the native MCP servers, and the documented `acp-mcp-call`
        // fallback reads these from the shell.
        const agentLaunches = h.agentLaunches();
        expect(agentLaunches).toHaveLength(2);
        expect(agentLaunches[1]?.environment).toMatchObject({
          T3CODE_THREAD_ID: threadId,
          T3_ACP_MCP_ENDPOINT: endpoint,
          T3_ACP_MCP_AUTHORIZATION: "Bearer antigravity-thread-token",
          T3_ACP_MCP_NODE: process.execPath,
          T3_ACP_MCP_ENTRYPOINT: entrypoint,
        });
        // Model refresh and sign-in launches are not part of a thread.
        expect(agentLaunches[0]?.environment).toMatchObject({
          T3CODE_THREAD_ID: "thread-antigravity-ambient",
          T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:9/ambient",
          T3_ACP_MCP_AUTHORIZATION: "Bearer ambient-token",
          T3_ACP_MCP_NODE: "/ambient/node",
          T3_ACP_MCP_ENTRYPOINT: "/ambient/entrypoint.mjs",
        });
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        yield* h.use(h.signedOut);
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(yield* h.readRuns).toEqual([h.first.name, h.signedOut.name]);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when agy is not on PATH", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      yield* h.removeCli;
      // PATH lookups are cached for 30 seconds.
      yield* TestClock.adjust("31 seconds");
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      expect(error.cause).toMatchObject({
        _tag: "ProviderSetupError",
        operation: "resolve",
        detail: "Antigravity (agy) is not installed on this environment's PATH. Orbit installs it.",
      });
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.agentLaunches()).toHaveLength(1);
      yield* h.assertClosed;
    }),
  );

  it.effect.skipIf(windowsHost)(
    "publishes the version of the agy on PATH at every health check",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        // The first check starts the agent once, so models are ready before any thread.
        expect(h.firstCheck).toMatchObject({
          status: "ready",
          version: "1.5.13",
          auth: { status: "authenticated" },
        });
        expect(h.firstCheck.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect((yield* h.instance.snapshot.refresh).version).toBe("1.5.13");
        // Orbit updates agy in place on PATH; the next check reports the new build.
        yield* h.use(yield* h.makeExecutable("runtime updated", { version: "1.6.0" }));
        const updated = yield* h.instance.snapshot.refresh;
        expect(updated.version).toBe("1.6.0");
        expect(updated.installed).toBe(true);
        yield* h.removeCli;
        // PATH lookups are cached for 30 seconds.
        yield* TestClock.adjust("31 seconds");
        const missing = yield* h.instance.snapshot.refresh;
        expect(missing.version).toBeNull();
        expect(missing.installed).toBe(false);
        // Once the account is known, a health check only asks `agy --version`.
        expect(h.agentLaunches()).toEqual([]);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "reports the missing SOCKS dependency when session creation fails and keeps the catalog",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const before = yield* h.instance.snapshot.getSnapshot;
        yield* h.use(
          yield* h.makeExecutable("runtime socks", {
            newSessionErrorData: { details: "python-socks is required to use a SOCKS proxy" },
          }),
        );
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toBe(
          "Could not refresh Antigravity models. The previous model list is unchanged. Antigravity reported: python-socks is required to use a SOCKS proxy",
        );
        const after = yield* h.instance.snapshot.getSnapshot;
        expect(after.models).toEqual(before.models);
        expect(after.auth).toEqual(before.auth);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "never copies unrecognized agent error details into the refresh error",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const before = yield* h.instance.snapshot.getSnapshot;
        const generic =
          "Could not refresh Antigravity models. The previous model list is unchanged.";
        const secret = "https://accounts.example.test/o/oauth2?code=sk-secret-123";
        yield* h.use(
          yield* h.makeExecutable("runtime socks with extra", {
            newSessionErrorData: {
              details: `Traceback (most recent call last):\n  proxy ${secret}\npython-socks is required to use a SOCKS proxy`,
            },
          }),
        );
        const known = yield* h.refresh().pipe(Effect.flip);
        expect(known.detail).toBe(
          `${generic} Antigravity reported: python-socks is required to use a SOCKS proxy`,
        );

        for (const [name, data] of [
          ["runtime unknown details", { details: `Token refresh failed for ${secret}` }],
          ["runtime object details", { details: { stack: "secret frame", env: { HOME: "/" } } }],
          ["runtime no details", ["python-socks is required to use a SOCKS proxy"]],
        ] as const) {
          yield* h.use(yield* h.makeExecutable(name, { newSessionErrorData: data }));
          const error = yield* h.refresh().pipe(Effect.flip);
          expect(error.detail).toBe(generic);
        }
        const after = yield* h.instance.snapshot.getSnapshot;
        expect(after.models).toEqual(before.models);
        expect(after.auth).toEqual(before.auth);
        expect(JSON.stringify(after)).not.toContain("sk-secret-123");
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "removes runtime temp directories left by a previous server on create",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const instanceId = ProviderInstanceId.make("antigravity-orphan-sweep");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        const legacyRoot = path.join(directories.profile, "antigravity-acp", "tmp");
        for (const root of [directories.runtimeTemp, legacyRoot]) {
          const orphan = path.join(root, "run-orphan", "_MEI123", "google3");
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
        }
        yield* AntigravityDriver.create({
          instanceId,
          displayName: "Sweep",
          enabled: false,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        });
        expect(yield* fs.exists(directories.runtimeTemp)).toBe(false);
        expect(yield* fs.exists(legacyRoot)).toBe(false);
      }),
  );
});
