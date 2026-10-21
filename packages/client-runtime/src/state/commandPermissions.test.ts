import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(close.permissionAtom(env))).toBe(false);
        expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthPreviewOperateScope],
            permissions: [AuthPreviewOperateScope],
          }),
        );
        expect(registry.get(close.permissionAtom(env))).toBe(true);
        yield* close.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(close.permissionAtom(other))).toBe(false);
        expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );

  it("checks the destination settings grant again when renaming a host", async () => {
    const registry = AtomRegistry.make();
    const unmounts = [registry.mount(sessions(env)), registry.mount(sessions(other))];
    const input = { patch: { environmentLabel: "Studio Mac" } };
    const writes: Array<typeof input> = [];
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.rename-host",
      tag: WS_METHODS.serverUpdateSettings,
      execute: (payload) =>
        Effect.sync(() => {
          writes.push(payload as typeof input);
          return DEFAULT_SERVER_SETTINGS;
        }),
    });
    try {
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        }),
      );
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(command.permissionAtom(env, input))).toBe(true);
      expect(registry.get(command.permissionAtom(other, input))).toBe(false);
      expect((await command.run(registry, { environmentId: other, input }))._tag).toBe("Failure");
      expect(writes).toHaveLength(0);
      expect((await command.run(registry, { environmentId: env, input }))._tag).toBe("Success");
      expect(writes).toEqual([input]);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      expect(registry.get(command.permissionAtom(env, input))).toBe(false);
      expect((await command.run(registry, { environmentId: env, input }))._tag).toBe("Failure");
      expect(writes).toHaveLength(1);
    } finally {
      unmounts.forEach((unmount) => unmount());
      registry.dispose();
    }
  });

  it.effect(
    "requires provider permission for provider-only settings and both grants for mixed changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const settings = createCommandPermissions(runtime, WS_METHODS.serverUpdateSettings);
          const providerOnly = {
            patch: {},
            providerInstanceMutation: {
              operation: "remove",
              instanceId: ProviderInstanceId.make("work"),
            },
          };
          const mixed = { ...providerOnly, patch: { environmentLabel: "Studio" } };
          const providerPatch = { patch: { providerInstances: {} } };
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthProvidersManageScope],
              permissions: [AuthProvidersManageScope],
            }),
          );
          expect(registry.get(settings.permissionAtom(env))).toBe(false);
          expect(registry.get(settings.permissionAtom(env, providerOnly))).toBe(true);
          yield* settings.authorize(registry, env, providerOnly);
          expect(registry.get(settings.permissionAtom(env, providerPatch))).toBe(true);
          yield* settings.authorize(registry, env, providerPatch);
          expect(registry.get(settings.permissionAtom(env, mixed))).toBe(false);
          expect(
            (yield* settings.authorize(registry, env, mixed).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthSettingsWriteScope);
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthSettingsWriteScope],
              permissions: [AuthSettingsWriteScope],
            }),
          );
          expect(registry.get(settings.permissionAtom(env, providerOnly))).toBe(false);
          expect(registry.get(settings.permissionAtom(env, providerPatch))).toBe(false);
          expect(
            (yield* settings.authorize(registry, env, providerOnly).pipe(Effect.flip))
              .requiredPermission,
          ).toBe(AuthProvidersManageScope);
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthSettingsWriteScope, AuthProvidersManageScope],
              permissions: [AuthSettingsWriteScope, AuthProvidersManageScope],
            }),
          );
          expect(registry.get(settings.permissionAtom(env, mixed))).toBe(true);
          yield* settings.authorize(registry, env, mixed);
        }),
      ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect.each(["commit", "push", "commit_push", "create_pr", "commit_push_pr"] as const)(
  "%s needs thread read permission only when generating a PR from a thread",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, WS_METHODS.gitRunStackedAction);
        const input = { actionId: "action", cwd: "/repo", action };
        const withThread = { ...input, threadId: ThreadId.make("thread") };
        const session = {
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(session));
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        const readsThread = action === "create_pr" || action === "commit_push_pr";
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(!readsThread);
        if (readsThread) {
          expect(
            yield* command.authorize(registry, env, withThread).pipe(Effect.flip),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
        } else {
          yield* command.authorize(registry, env, withThread);
        }
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...session,
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(true);
        yield* command.authorize(registry, env, withThread);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);
