import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  applyAcpRegistryAvailableCommands,
  AcpRegistryDriver,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

const cwdProbeAgent = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const cwd = fs.realpathSync(process.cwd());
const entries = fs.readdirSync(cwd);
let client;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") client = request.params.clientInfo.name;
  fs.appendFileSync(process.argv.at(-1), JSON.stringify({
    method: request.method, client, cwd, entries,
    sessionCwd: request.params?.cwd === undefined ? undefined : fs.realpathSync(request.params.cwd),
  }) + "\n");
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: {} } },
    authMethods: [{ id: "browser", name: "Browser" }],
  };
  if (request.method === "session/new") {
    result = {
      sessionId: "cwd-session",
      models: { currentModelId: "test", availableModels: [{ modelId: "test", name: "Test" }] },
    };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "cwd-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } }) + "\n");
  }
  if (request.method === "session/list") result = { sessions: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;

const decodeCwdLog = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      client: Schema.String,
      cwd: Schema.String,
      entries: Schema.Array(Schema.String),
      sessionCwd: Schema.optional(Schema.String),
    }),
  ),
);

it.live("isolates background ACP probes while retaining explicit project working directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const serverCwd = path.join(root, "server-home");
    const projectCwd = path.join(root, "project");
    const logPath = path.join(root, "requests.jsonl");
    const agentPath = path.join(root, "cwd-agent.cjs");
    yield* fs.writeFileString(agentPath, cwdProbeAgent);
    yield* fs.makeDirectory(serverCwd);
    yield* fs.makeDirectory(projectCwd);
    yield* fs.writeFileString(path.join(serverCwd, "server-data"), "");
    const probeDirectories = new Set<string>();

    for (const [source, resolution] of [
      ["local", "absolute"],
      ["registry", "absolute"],
      ["local", "relative-command"],
      ["registry", "relative-command"],
      ["local", "relative-path"],
      ["registry", "relative-path"],
    ] as const) {
      yield* Effect.gen(function* () {
        const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: root,
          toolsDir: path.join(root, "tools"),
          registryUrl: "https://registry.test/registry.json",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      version: "1.0.0",
                      agents: [
                        {
                          id: "test-agent",
                          name: "Test",
                          version: "1.0.0",
                          description: "Test agent",
                          distribution: {
                            npx: { package: "test-agent@1.0.0", args: [agentPath, logPath] },
                          },
                        },
                      ],
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
        if (source === "registry") yield* catalog.search({ query: "test" });
        const commandPath =
          resolution === "relative-command"
            ? path.relative(process.cwd(), process.execPath)
            : resolution === "relative-path"
              ? path.basename(process.execPath)
              : process.execPath;
        const instance = yield* AcpRegistryDriver.create({
          ...identity,
          enabled: true,
          environment: [],
          config: decodeSettings({
            source,
            agentId: "test-agent",
            commandPath,
            commandArgs: [agentPath, logPath],
          }),
        }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
        const discovered = yield* Stream.concat(
          Stream.fromEffect(instance.snapshot.getSnapshot),
          instance.snapshot.streamChanges,
        ).pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.some((model) => model.slug === "test") ||
              snapshot.status === "error" ||
              (snapshot.installed && snapshot.status === "warning"),
          ),
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        const snapshot = Option.getOrThrow(discovered);
        expect(snapshot, snapshot.message).toMatchObject({
          status: "ready",
          models: [expect.objectContaining({ slug: "test" })],
        });
        const auth = instance.auth!;
        yield* auth.subscribe("test").pipe(
          Stream.filter((state) => (state.methods?.length ?? 0) > 0),
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        yield* auth.refreshMethods!;
        const modelSelection = { instanceId: instance.instanceId, model: "test" };
        const runtimePolicy = {
          cwd: projectCwd,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
        };
        const threadId = ThreadId.make("cwd-thread");
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cwd-provider-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        yield* instance.acpSessionManagement!.listSessions({ cwd: projectCwd });
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          ...(resolution === "relative-path"
            ? { PATH: path.relative(process.cwd(), path.dirname(process.execPath)) }
            : {}),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: serverCwd })),
      );
    }
    const records = (yield* fs.readFileString(logPath))
      .trim()
      .split("\n")
      .map((line) => decodeCwdLog(line));
    const background = records.filter(
      (record) =>
        record.client === "t3-code-provider-test" || record.client === "t3-code-provider-auth",
    );
    expect(background.filter((record) => record.method === "session/new")).toHaveLength(6);
    expect(
      background.filter((record) => record.client === "t3-code-provider-auth").length,
    ).toBeGreaterThanOrEqual(12);
    for (const record of background) {
      expect(record.cwd).not.toBe(serverCwd);
      expect(record.entries).toEqual([]);
      if (record.method === "session/new") expect(record.sessionCwd).toBe(record.cwd);
      probeDirectories.add(record.cwd);
    }
    for (const directory of probeDirectories) expect(yield* fs.exists(directory)).toBe(false);
    const projectRecords = records.filter((record) => !background.includes(record));
    expect(projectRecords.some((record) => record.method === "session/new")).toBe(true);
    expect(projectRecords.some((record) => record.method === "session/list")).toBe(true);
    for (const record of projectRecords) {
      expect(record.cwd).toBe(projectCwd);
      if (record.method === "session/new") expect(record.sessionCwd).toBe(projectCwd);
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
  ),
);

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).models,
    ).toEqual(provider.models);

    const liveOptions = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
        currentValue: "high",
      },
    ];
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: liveOptions },
        [],
      ).models,
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});
