import {
  EnvironmentId,
  GetThreadMetadataInput,
  OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  SetThreadNameInput,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  clearAllMcpProviderSessions,
  setMcpProviderSession,
  withMcpRequestedModelSelection,
  type McpProviderSessionConfig,
} from "../../McpProviderSession.ts";
import { ThreadToolkitHandlersLive } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMetadataInput = Schema.decodeUnknownSync(GetThreadMetadataInput);
const decodeNameInput = Schema.decodeUnknownSync(SetThreadNameInput);

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("environment-1");
const scope: McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "session-1",
  providerInstanceId: instanceId,
  capabilities: new Set(["thread"]),
  issuedAt: 1,
};
const requested: ModelSelection = {
  instanceId,
  model: "gpt-6-astra",
  options: [
    { id: "serviceTier", value: "priority" },
    { id: "reasoningEffort", value: "high" },
    { id: "cyberAccessProgram", value: "daybreakBlue" },
  ],
};
const session: McpProviderSessionConfig = {
  ...scope,
  endpoint: "http://private-host/mcp",
  authorizationHeader: "Bearer secret-token",
  requestedModelSelection: requested,
  agentDeviceEnvironment: { SECRET: "device-secret" },
};
const thread = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: threadId,
  projectId: "project-1",
  title: "Thread",
  modelSelection: requested,
  runtimeMode: "full-access",
  branch: "feature",
  worktreePath: "/worktree",
  latestTurn: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
};
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId,
  driver: "codex",
  displayName: "Codex Personal",
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated", email: "private@example.com" },
  checkedAt: thread.updatedAt,
  models: [
    {
      slug: requested.model,
      name: "GPT-6 Astra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "cyberAccessProgram",
            label: "Daybreak",
            type: "select",
            options: [
              { id: "standard", label: "Off" },
              { id: "daybreakBlue", label: "On" },
            ],
          },
        ],
      },
    },
  ],
});
const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId,
  label: "My host",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.42",
  capabilities: { repositoryIdentity: true, connectionProbe: true },
};
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, bytes) => Effect.succeed(bytes),
});

afterEach(clearAllMcpProviderSessions);

const makeHarness = Effect.fn("makeThreadToolkitHarness")(function* (
  options: {
    thread?: OrchestrationThreadShell | null;
    project?: OrchestrationProjectShell | null;
    providers?: ReadonlyArray<ServerProvider>;
    readFailure?: boolean;
    renameFailure?: boolean;
  } = {},
) {
  let currentThread = options.thread === undefined ? thread : options.thread;
  const calls = { projects: 0, providers: 0, environment: 0 };
  const commands: OrchestrationCommand[] = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        options.readFailure
          ? Effect.fail(new PersistenceSqlError({ operation: "read", detail: "secret db path" }))
          : Effect.sync(() => Option.fromNullishOr(id === threadId ? currentThread : null)),
      getProjectShellById: () =>
        Effect.sync(() => {
          calls.projects++;
          return Option.fromNullishOr(options.project === undefined ? project : options.project);
        }),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        options.renameFailure
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "secret database path",
              }),
            )
          : Effect.sync(() => {
              commands.push(command);
              return { sequence: 1 };
            }),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.sync(() => {
        calls.providers++;
        return options.providers ?? [provider];
      }),
    }),
    Layer.mock(ServerEnvironment)({
      getDescriptor: Effect.sync(() => {
        calls.environment++;
        return descriptor;
      }),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadToolkit.pipe(
    Effect.provide(ThreadToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ThreadToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
    invocation = scope,
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (results) => results.at(-1)!.result as Tool.Success<(typeof ThreadToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext, withMcpRequestedModelSelection(invocation)),
    );
  return {
    call,
    calls,
    commands,
    setThread: (next: OrchestrationThreadShell) => {
      currentThread = next;
    },
  };
});

describe("thread metadata tools", () => {
  it.effect("reports the last request independently of live saved picker changes", () =>
    Effect.gen(function* () {
      setMcpProviderSession(session);
      const harness = yield* makeHarness();
      harness.setThread({
        ...thread,
        modelSelection: {
          instanceId,
          model: "next-model",
          options: [{ id: "serviceTier", value: "flex" }],
        },
      });
      const result = yield* harness.call("get_thread_metadata", {
        fields: ["model", "serviceTier", "reasoningEffort", "daybreak"],
      });
      expect(result.model).toMatchObject({
        savedSelection: { model: "next-model" },
        requestedSelection: requested,
        catalog: { name: "GPT-6 Astra" },
        providerConfirmed: null,
      });
      expect(result.serviceTier).toEqual({
        saved: "flex",
        requested: "priority",
        providerConfirmed: null,
      });
      expect(result.reasoningEffort).toEqual({
        saved: null,
        requested: "high",
        providerConfirmed: null,
      });
      expect(result.daybreak).toEqual({
        access: "available",
        availablePrograms: ["daybreakBlue"],
        saved: null,
        requested: "daybreakBlue",
        providerConfirmed: null,
      });
      expect(Object.keys(result).sort()).toEqual([
        "daybreak",
        "model",
        "reasoningEffort",
        "serviceTier",
      ]);
      expect(harness.calls).toEqual({ projects: 0, providers: 1, environment: 0 });
    }),
  );

  it.effect("projects fields exactly and skips unrelated reads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("get_thread_metadata", { fields: ["name", "name"] })).toEqual({
        name: "Thread",
      });
      expect(yield* harness.call("get_thread_metadata", { fields: [] })).toEqual({});
      expect(harness.calls).toEqual({ projects: 0, providers: 0, environment: 0 });
      expect(() => decodeMetadataInput({ fields: ["secret"] })).toThrow();
    }),
  );

  it.effect("returns all fields by default with only safe host and environment data", () =>
    Effect.gen(function* () {
      setMcpProviderSession(session);
      const harness = yield* makeHarness();
      const result = yield* harness.call("get_thread_metadata", {});
      expect(Object.keys(result).sort()).toEqual([
        "daybreak",
        "environment",
        "host",
        "id",
        "model",
        "name",
        "project",
        "provider",
        "reasoningEffort",
        "runtime",
        "serviceTier",
      ]);
      expect(result.host).toEqual({ hostname: expect.any(String), platform: descriptor.platform });
      expect(result.environment).toEqual({
        id: environmentId,
        name: "My host",
        serverVersion: "0.0.42",
      });
      expect(result.provider).toEqual({ instanceId, kind: "codex", name: "Codex Personal" });
      expect(result.runtime).toMatchObject({
        cwd: "/worktree",
        branch: "feature",
        runtimeMode: "full-access",
      });
      const serialized = encodeJson(result);
      for (const secret of [
        "secret-token",
        "device-secret",
        "private@example.com",
        "private-host",
        'capabilities":{"repositoryIdentity',
      ])
        expect(serialized).not.toContain(secret);
    }),
  );

  it.effect("uses project cwd without a worktree and handles a missing project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: { ...thread, worktreePath: null } });
      expect(
        (yield* harness.call("get_thread_metadata", { fields: ["runtime"] })).runtime?.cwd,
      ).toBe("/workspace");
      const missing = yield* makeHarness({
        project: null,
        thread: { ...thread, worktreePath: null },
      });
      expect(
        yield* missing.call("get_thread_metadata", { fields: ["project", "runtime"] }),
      ).toMatchObject({ project: null, runtime: { cwd: null } });
    }),
  );

  it.effect("does not expose another credential's session selection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const mismatch of [
        { providerSessionId: "other-session" },
        { providerInstanceId: ProviderInstanceId.make("other-instance") },
        { environmentId: EnvironmentId.make("other-environment") },
      ]) {
        setMcpProviderSession({ ...session, ...mismatch });
        const result = yield* harness.call("get_thread_metadata", {
          fields: ["model", "daybreak"],
        });
        expect(result.model?.requestedSelection).toBeNull();
        expect(result.model?.catalog).toBeNull();
        expect(result.daybreak?.access).toBe("unknown");
      }
    }),
  );

  it.effect("reports missing sessions, providers and models as unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [] });
      const result = yield* harness.call("get_thread_metadata", {
        fields: ["model", "provider", "serviceTier", "daybreak"],
      });
      expect(result.model?.requestedSelection).toBeNull();
      expect(result.provider).toEqual({ instanceId, kind: null, name: null });
      expect(result.serviceTier?.requested).toBeNull();
      expect(result.daybreak?.access).toBe("unknown");
      setMcpProviderSession({
        ...session,
        requestedModelSelection: { instanceId, model: "unlisted-model" },
      });
      expect(
        (yield* harness.call("get_thread_metadata", { fields: ["model"] })).model?.catalog,
      ).toBeNull();
    }),
  );

  it.effect("does not infer Daybreak access from aliases, custom models or absent discovery", () =>
    Effect.gen(function* () {
      setMcpProviderSession(session);
      const knownModel = provider.models[0]!;
      for (const changed of [
        { ...provider, models: [{ ...knownModel, slug: "canonical", aliases: [requested.model] }] },
        { ...provider, models: [{ ...knownModel, isCustom: true }] },
        { ...provider, models: [{ ...knownModel, capabilities: null }] },
        { ...provider, auth: { status: "unknown" as const } },
      ]) {
        const harness = yield* makeHarness({ providers: [changed] });
        expect(
          (yield* harness.call("get_thread_metadata", { fields: ["daybreak"] })).daybreak?.access,
        ).toBe("unknown");
      }
    }),
  );

  it.effect("reads Claude effort without fabricating a service tier or Daybreak support", () =>
    Effect.gen(function* () {
      setMcpProviderSession({
        ...session,
        requestedModelSelection: {
          instanceId,
          model: "claude",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        },
      });
      const harness = yield* makeHarness({
        providers: [{ ...provider, driver: ProviderDriverKind.make("claudeAgent") }],
      });
      const result = yield* harness.call("get_thread_metadata", {
        fields: ["reasoningEffort", "serviceTier", "daybreak"],
      });
      expect(result.reasoningEffort?.requested).toBe("max");
      expect(result.serviceTier?.requested).toBeNull();
      expect(result.daybreak?.access).toBe("unsupported");
    }),
  );

  it.effect("requires capability and looks up only the credential's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const denied = { ...scope, capabilities: new Set<never>() };
      const other = { ...scope, threadId: ThreadId.make("other-thread") };
      for (const call of [
        harness.call("get_thread_metadata", {}, denied),
        harness.call("set_thread_name", { name: "Renamed" }, denied),
      ])
        expect(yield* call.pipe(Effect.flip)).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "thread",
        });
      for (const call of [
        harness.call("get_thread_metadata", {}, other),
        harness.call("set_thread_name", { name: "Renamed" }, other),
      ])
        expect(yield* call.pipe(Effect.flip)).toMatchObject({
          _tag: "ThreadMetadataNotFoundError",
        });
      expect(harness.commands).toEqual([]);
    }),
  );

  it.effect("trims names and dispatches only title, including an unchanged name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const input = decodeNameInput({ name: "  Renamed  " });
      expect(yield* harness.call("set_thread_name", input)).toEqual({
        id: threadId,
        name: "Renamed",
      });
      yield* harness.call("set_thread_name", { name: "Thread" });
      expect(harness.commands).toEqual([
        { type: "thread.meta.update", commandId: expect.any(String), threadId, title: "Renamed" },
        { type: "thread.meta.update", commandId: expect.any(String), threadId, title: "Thread" },
      ]);
      expect(() => decodeNameInput({ name: " \n " })).toThrow();
    }),
  );

  it.effect("preserves failed read and rename causes behind safe messages", () =>
    Effect.gen(function* () {
      const reads = yield* makeHarness({ readFailure: true });
      const readError = yield* reads.call("get_thread_metadata", {}).pipe(Effect.flip);
      expect(readError).toMatchObject({
        _tag: "ThreadMetadataReadError",
        cause: { _tag: "PersistenceSqlError" },
      });
      const renames = yield* makeHarness({ renameFailure: true });
      const renameError = yield* renames
        .call("set_thread_name", { name: "Name" })
        .pipe(Effect.flip);
      expect(renameError).toMatchObject({
        _tag: "ThreadMetadataRenameError",
        cause: { _tag: "OrchestrationCommandInvariantError" },
      });
      expect(encodeJson([readError.message, renameError.message])).not.toContain("secret");
    }),
  );
});
