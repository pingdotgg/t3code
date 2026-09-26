import * as ProcessRunner from "../processRunner.ts";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { HostApiInvocationMetadata, HostApiRootAuthority } from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import {
  PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH,
  type ProvidersStatusEvent,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderRegistrySnapshot } from "../provider/Services/ProviderRegistry.ts";
import { createProvidersStatusApiProvider, projectProviderStatuses } from "./providersStatusApi.ts";

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.2.3",
  status: "ready",
  auth: {
    status: "authenticated",
    type: "subscription",
    label: "private-account",
    email: "user@example.test",
  },
  checkedAt: "2026-01-01T00:00:00.000Z",
  message: "private diagnostic text",
  supportsTextGeneration: true,
  supportsConversationRollback: true,
  reportsContextWindow: true,
  models: [{ slug: "gpt-5.6", name: "GPT 5.6", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  workspaceSnapshots: [
    { cwd: "/private/workspace", checkedAt: "x", slashCommands: [], skills: [] },
  ],
  ...overrides,
});

function fixture(
  updates: PubSub.PubSub<ProviderRegistrySnapshot>,
  subscribed: Deferred.Deferred<void>,
  state: Ref.Ref<ProviderRegistrySnapshot>,
  snapshotGate?: Deferred.Deferred<void>,
) {
  let cwd = "/workspace";
  let allowed = true;
  let reads = 0;
  let detached = false;
  let releaseNotice: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseNotice = resolve;
  });
  const projectId = ProjectId.make("project-a");
  const api = createProvidersStatusApiProvider({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.sync(() => Option.some({ projectId, workspaceRoot: cwd, deletedAt: null })),
    },
    threads: { getById: () => Effect.succeedNone },
    providers: {
      getProvidersSnapshot: Effect.gen(function* () {
        reads++;
        if (snapshotGate) yield* Deferred.await(snapshotGate);
        return yield* Ref.get(state);
      }),
      subscribeChanges: Effect.acquireRelease(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(updates);
          yield* Deferred.succeed(subscribed, undefined);
          return subscription;
        }),
        () =>
          Effect.sync(() => {
            detached = true;
            releaseNotice?.();
          }),
      ),
    },
  });
  const context: ViewContext = {
    client: "web",
    workspaceRevision: JSON.stringify(["/workspace", null]),
    resource: {
      namespace: "example.providers-status",
      id: "view",
      environmentId: "env-a",
      projectId,
    },
  };
  const metadata: HostApiInvocationMetadata = {
    callId: "call",
    callerId: "consumer",
    rootCallerId: "consumer",
    providerId: api.providerId,
    providerGeneration: 1,
    callerGenerations: [],
    principal: {
      kind: "environment-session",
      id: "session",
      environmentId: "env-a",
      scopes: ["orchestration:read"],
    },
    assertAuthority: async () => {
      if (!allowed) throw new Error("revoked");
    },
  };
  const controller = new AbortController();
  return {
    api,
    context,
    metadata,
    controller,
    stream: () =>
      api.subscribe!("subscribe", {}, context, controller.signal, metadata)[Symbol.asyncIterator](),
    emit: (providers: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        // Stamp the publication with the registry revision, atomically with
        // the state swap — mirrors ProviderRegistryLive's Ref+PubSub pair.
        const stamped = yield* Ref.modify(state, (previous) => {
          const next = { revision: previous.revision + 1, providers };
          return [next, next];
        });
        yield* PubSub.publish(updates, stamped);
      }),
    subscriptionReady: Deferred.await(subscribed),
    released,
    reads: () => reads,
    detached: () => detached,
    revoke: () => {
      allowed = false;
    },
    move: () => {
      cwd = "/other";
    },
  };
}

const makeFixture = (initial: ServerProvider[] = [provider()]) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded<ProviderRegistrySnapshot>();
    const subscribed = yield* Deferred.make<void>();
    const state = yield* Ref.make<ProviderRegistrySnapshot>({
      revision: 0,
      providers: initial,
    });
    return fixture(updates, subscribed, state);
  });

it("projects identity, lifecycle and capability flags without credential-bearing fields", () => {
  const event = projectProviderStatuses([provider()]);
  expect(event).toEqual({
    kind: "snapshot",
    scope: "environment",
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        checkedAt: "2026-01-01T00:00:00.000Z",
        supportsConversationRollback: true,
        supportsTextGeneration: true,
        reportsContextWindow: true,
      },
    ],
  });
  expect(JSON.stringify(event)).not.toMatch(/private|user@example|workspace|version|subscription/);
  const unavailable = projectProviderStatuses([
    provider({ availability: "unavailable", enabled: false, installed: false }),
  ]);
  expect(unavailable.providers[0]?.availability).toBe("unavailable");
  expect(projectProviderStatuses([]).providers).toEqual([]);
});

it("caps the projected display label so a valid long provider name stays in schema", () => {
  const longName = `Custom ${"Codex ".repeat(60)}Instance`; // 300+ chars, valid per TrimmedNonEmptyString
  const event = projectProviderStatuses([provider({ displayName: longName })]);
  expect(event.providers[0]?.displayName).toBe(
    longName.slice(0, PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH),
  );
  expect(event.providers[0]?.displayName).toHaveLength(PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH);
});

it.effect("streams the initial snapshot then registry updates, and detaches on return", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const stream = f.stream();
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectProviderStatuses([provider()]),
    );
    yield* f.emit([provider({ status: "error" })]);
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectProviderStatuses([provider({ status: "error" })]),
    );
    yield* Effect.promise(() => stream.return!());
    yield* Effect.promise(() => f.released);
    expect(f.detached()).toBe(true);
  }),
);

it.effect("fences queued publications that predate the snapshot", () =>
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded<ProviderRegistrySnapshot>();
    const subscribed = yield* Deferred.make<void>();
    const snapshotGate = yield* Deferred.make<void>();
    const state = yield* Ref.make<ProviderRegistrySnapshot>({
      revision: 0,
      providers: [provider()],
    });
    // The snapshot read hangs on the gate; the provider must already be
    // subscribed before it resolves, or these publishes fall into the gap.
    const f = fixture(updates, subscribed, state, snapshotGate);
    const stream = f.stream();
    const first = stream.next();
    yield* f.subscriptionReady;
    // Two publishes land while the snapshot read is gated, so the read
    // returns the newest state (warning, revision 2). Replaying the queued
    // error (rev 1) and warning (rev 2) would deliver warning -> error ->
    // warning — stale status after newer status. The revision fence drops
    // everything at-or-below the snapshot's revision.
    yield* f.emit([provider({ status: "error" })]);
    yield* f.emit([provider({ status: "warning" })]);
    yield* Deferred.succeed(snapshotGate, undefined);
    expect((yield* Effect.promise(() => first)).value?.value).toEqual(
      projectProviderStatuses([provider({ status: "warning" })]),
    );
    // The live feed still flows after the fenced burst.
    yield* f.emit([provider({ status: "error" })]);
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectProviderStatuses([provider({ status: "error" })]),
    );
    yield* Effect.promise(() => stream.return!());
    yield* Effect.promise(() => f.released);
    expect(f.detached()).toBe(true);
  }),
);

it.effect("does not resend when only fields outside the projection change", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const stream = f.stream();
    yield* Effect.promise(() => stream.next());
    // A usage-meter tick changes the registry payload but not the projection:
    // the duplicate is deduplicated and the following real change is what lands.
    yield* f.emit([provider({ message: "different private text" })]);
    yield* f.emit([provider({ status: "warning" })]);
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectProviderStatuses([provider({ status: "warning" })]),
    );
    yield* Effect.promise(() => stream.return!());
  }),
);

for (const action of ["revoke", "move"] as const) {
  it.effect("rechecks " + action + " before delivery and detaches the registry stream", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const stream = f.stream();
      yield* Effect.promise(() => stream.next());
      f[action]();
      yield* f.emit([provider({ status: "error" })]);
      yield* Effect.promise(() => expect(stream.next()).rejects.toThrow());
      yield* Effect.promise(() => f.released);
      expect(f.detached()).toBe(true);
    }),
  );
}

it.effect("aborts while waiting for a registry update and detaches", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    const stream = f.stream();
    yield* Effect.promise(() => stream.next());
    const pending = stream.next();
    f.controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toThrow());
    yield* Effect.promise(() => f.released);
    expect(f.detached()).toBe(true);
  }),
);

it.effect(
  "rejects probing inputs, cursors, foreign principals and stale scope before reading the registry",
  () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const { assertAuthority: _assertAuthority, ...withoutAuthority } = f.metadata;
      expect(() =>
        f.api.subscribe!(
          "subscribe",
          { refresh: true },
          f.context,
          f.controller.signal,
          f.metadata,
        ),
      ).toThrow("Invalid");
      expect(() =>
        f.api.subscribe!("subscribe", {}, f.context, f.controller.signal, f.metadata, "cursor"),
      ).toThrow("resume");
      expect(() =>
        f.api.subscribe!("subscribe", {}, f.context, f.controller.signal, {
          ...f.metadata,
          principal: { ...f.metadata.principal!, environmentId: "foreign" },
        }),
      ).toThrow("authority");
      expect(() =>
        f.api.subscribe!("subscribe", {}, f.context, f.controller.signal, withoutAuthority),
      ).toThrow("authority");
      f.move();
      yield* Effect.promise(() => expect(f.stream().next()).rejects.toThrow());
      expect(f.reads()).toBe(0);
    }),
);

it.effect("revoked authority and pre-aborted streams never read the registry", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture();
    f.revoke();
    yield* Effect.promise(() => expect(f.stream().next()).rejects.toThrow("revoked"));
    const updates = yield* PubSub.unbounded<ProviderRegistrySnapshot>();
    const subscribed = yield* Deferred.make<void>();
    const abortedState = yield* Ref.make<ProviderRegistrySnapshot>({
      revision: 0,
      providers: [provider()],
    });
    const aborted = fixture(updates, subscribed, abortedState);
    aborted.controller.abort();
    yield* Effect.promise(() => expect(aborted.stream().next()).rejects.toThrow());
    expect(f.reads() + aborted.reads()).toBe(0);
  }),
);

it.effect(
  "installed packed consumer receives a long display name through broker event validation",
  () =>
    Effect.gen(function* () {
      const longName = `Custom ${"Codex ".repeat(60)}Instance`;
      const f = yield* makeFixture([provider({ displayName: longName })]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const built = yield* runner.run({
        command: "node",
        args: [
          path.resolve("../../packages/extension-sdk/bin/t3-extension.mjs"),
          "build",
          path.resolve("../../packages/extension-sdk/examples/providers-status"),
        ],
      });
      expect(built.code, built.stderr).toBe(0);
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "providers-status-" });
      const rootDir = yield* fs.realPath(temp);
      const runtime = yield* Effect.promise(() =>
        createExtensionRuntime({
          rootDir,
          environmentId: "env-a",
          services: [],
          apiProviders: [f.api],
          authorize: (installation, grant, context) =>
            installation.grants.capabilities.includes(grant) &&
            installation.grants.projectIds.includes(context.resource.projectId ?? ""),
        }),
      );
      try {
        const installed = yield* Effect.promise(() =>
          runtime.install(
            path.resolve("../../packages/extension-sdk/examples/providers-status/.t3-extension"),
            {
              capabilities: ["t3.providers/read"],
              projectIds: ["project-a"],
            },
          ),
        );
        const root: HostApiRootAuthority = {
          principal: f.metadata.principal!,
          allowWrite: false,
          revalidate: () => {},
        };
        const stream = runtime
          .subscribeApi(
            installed.id,
            installed.contentHash,
            {
              id: "example.providers-status/read",
              versionRange: "^1.0.0",
              name: "subscribe",
              input: {},
              context: f.context,
            },
            f.controller.signal,
            root,
          )
          [Symbol.asyncIterator]();
        // Broker event validation rejects a frame whose displayName exceeds
        // the schema bound; the projected label arrives capped instead.
        const frame = yield* Effect.promise(() => stream.next());
        const event = frame.value?.value as ProvidersStatusEvent | undefined;
        expect(event?.kind).toBe("snapshot");
        expect(event?.providers[0]?.displayName).toBe(
          longName.slice(0, PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH),
        );
        yield* Effect.promise(() => stream.return!());
        yield* Effect.promise(() => f.released);
        expect(f.detached()).toBe(true);
      } finally {
        yield* Effect.promise(() => runtime.dispose());
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
