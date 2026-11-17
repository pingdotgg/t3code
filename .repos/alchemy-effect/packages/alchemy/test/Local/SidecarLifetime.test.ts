import { expect, it } from "@alchemy.run/test";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { RpcProviderProxy } from "@/Local/RpcProviderProxy";
import { Stack, type StackSpec } from "@/Stack";
import type { EchoClient } from "./fixtures/rpc-echo.ts";

const options = { providers: Layer.empty, dev: true, sidecar: true };
const COMMAND_LOCAL = import.meta.resolve("../../src/Command/Local.ts", import.meta.url);
const ECHO = new URL("./fixtures/rpc-server-entry.ts", import.meta.url).href;
const BLOCKED_ECHO = new URL("./fixtures/rpc-blocked-provider.ts", import.meta.url).href;
type StackShape = Omit<StackSpec, "output">;
type Handle = NonNullable<ReturnType<typeof Core.makeSidecarHandle>>;
const dummyStack = (name: string): StackShape => ({
  name,
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
});

const runAsFile = <A, E, R>(handle: Handle, stackName: string, body: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const sharedScope = Scope.makeUnsafe("sequential");
    return Core.toEffect(
      body.pipe(Effect.provideService(Stack, dummyStack(stackName))) as Core.TestEffect<A>,
      options,
      sharedScope,
      handle,
    ).pipe(Effect.ensuring(Scope.close(sharedScope, Exit.void)));
  });

const reserve = (profile?: string) =>
  Effect.acquireRelease(
    Effect.sync(() => Core.makeSidecarHandle({ ...options, profile })!),
    (handle) => handle.close,
  );

const echo = (handle: Handle, stackName: string) =>
  runAsFile(
    handle,
    stackName,
    Effect.gen(function* () {
      const proxy = yield* RpcProviderProxy;
      return (yield* proxy.get(ECHO, "Test.Echo")) as unknown as EchoClient;
    }),
  );

it.live(
  "sidecar POST still returns a ws URL after the first file's scope closes",
  () =>
    Effect.gen(function* () {
      const handle = yield* reserve();
      for (const stackName of ["sidecar-lifetime-a", "sidecar-lifetime-b"]) {
        yield* runAsFile(
          handle,
          stackName,
          Effect.gen(function* () {
            const proxy = yield* RpcProviderProxy;
            expect(yield* proxy.get(COMMAND_LOCAL, "Command.Dev")).toBeDefined();
          }),
        );
      }
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 60_000, exclusive: true },
);

it.live(
  "unused reservations and closed handles never start a sidecar",
  () =>
    Effect.gen(function* () {
      const baseline = yield* Core.sidecarDiagnostics;
      const handle = yield* reserve("sidecar-unused-reservation");
      const reserved = yield* Core.sidecarDiagnostics;
      expect(reserved.reservations).toBe(baseline.reservations + 1);
      expect(reserved.started).toBe(baseline.started);
      const server = yield* runAsFile(
        handle,
        "unused-handle",
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).serverDiagnostics;
        }),
      );
      expect(server).toBeUndefined();
      expect((yield* Core.sidecarDiagnostics).started).toBe(baseline.started);
      yield* handle.close;
      yield* handle.close;
      expect(yield* Core.sidecarDiagnostics).toEqual(baseline);
      const closed = yield* echo(handle, "closed-handle").pipe(Effect.exit);
      expect(closed._tag).toBe("Failure");
      expect(yield* Core.sidecarDiagnostics).toEqual(baseline);
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 30_000, exclusive: true },
);

it.live(
  "last session owner finalizes its context while queued files retain the singleton",
  () =>
    Effect.gen(function* () {
      const profile = "sidecar-session-owners";
      const baseline = yield* Core.sidecarDiagnostics;
      const first = yield* reserve(profile);
      const second = yield* reserve(profile);
      const queued = yield* reserve(profile);
      const a = yield* echo(first, "shared-owner-stack");
      const b = yield* echo(second, "shared-owner-stack");
      const before = yield* a.stats();
      expect(before.active).toBe(1);
      expect(before.built).toBe(1);
      expect((yield* Core.sidecarDiagnostics).sessions).toBe(baseline.sessions + 1);
      expect((yield* Core.sidecarDiagnostics).owners).toBe(baseline.owners + 2);
      yield* first.close;
      expect(yield* b.echo("still owned")).toBe("echo:still owned");
      expect((yield* b.stats()).finalized).toBe(0);
      yield* second.close;
      const released = yield* Core.sidecarDiagnostics;
      expect(released.sessions).toBe(baseline.sessions);
      expect(released.owners).toBe(baseline.owners);
      expect(released.connections).toBe(baseline.connections);
      expect(released.started).toBe(baseline.started + 1);

      const later = yield* echo(queued, "queued-owner-stack");
      expect(yield* later.identity()).toEqual({
        name: "queued-owner-stack",
        stage: "test",
      });
      expect(yield* later.stats()).toEqual({
        active: 1,
        built: 2,
        finalized: 1,
      });
      yield* queued.close;
      expect(yield* Core.sidecarDiagnostics).toEqual(baseline);
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 60_000, exclusive: true },
);

it.live(
  "cancelled and rejected lookups preserve another owner's live session",
  () =>
    Effect.gen(function* () {
      const first = yield* reserve();
      const second = yield* reserve();
      const name = "shared-lookup-cancellation";
      const provider = yield* echo(first, name);
      yield* provider.retainArtifact();
      const initial = yield* provider.stats();
      const inspect = runAsFile(
        first,
        name,
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).serverDiagnostics;
        }),
      );
      const baseline = yield* inspect;
      expect(baseline).toBeDefined();
      const pending = yield* runAsFile(
        second,
        name,
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).get(BLOCKED_ECHO, "Test.Echo");
        }),
      ).pipe(Effect.forkChild);
      const building = yield* inspect.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: (counts) => counts?.building === baseline!.building + 1,
        }),
      );
      expect(building?.building).toBe(baseline!.building + 1);
      yield* Fiber.interrupt(pending);
      expect(yield* provider.echo("after cancellation")).toBe("echo:after cancellation");
      expect(yield* provider.artifactCount()).toBe(1);
      expect((yield* provider.stats()).finalized).toBe(initial.finalized);

      const rejected = yield* runAsFile(
        second,
        name,
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).get(ECHO, "Test.Missing");
        }),
      ).pipe(Effect.exit);
      expect(rejected._tag).toBe("Failure");
      yield* second.close;
      expect(yield* provider.echo("after rejected lookup")).toBe("echo:after rejected lookup");
      expect(yield* provider.artifactCount()).toBe(1);
      expect((yield* provider.stats()).finalized).toBe(initial.finalized);
      expect((yield* inspect)?.contexts).toBe(baseline!.contexts);
      yield* first.close;
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 60_000, exclusive: true },
);

it.live(
  "a dead sidecar transport reconnects without reviving the old generation",
  () =>
    Effect.gen(function* () {
      const handle = yield* reserve("sidecar-transport-recovery");
      const name = "transport-recovery";
      const original = yield* echo(handle, name);
      const pid = yield* original.processId();
      yield* Effect.sync(() => process.kill(pid, "SIGKILL"));
      expect((yield* original.echo("dead transport").pipe(Effect.exit))._tag).toBe("Failure");
      const recovered = yield* echo(handle, name).pipe(
        Effect.exit,
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: Exit.isSuccess,
        }),
      );
      expect(recovered._tag).toBe("Success");
      if (Exit.isFailure(recovered)) return yield* Effect.failCause(recovered.cause);
      expect(yield* recovered.value.echo("reconnected")).toBe("echo:reconnected");
      expect(yield* recovered.value.processId()).not.toBe(pid);
      yield* handle.close;
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 60_000, exclusive: true },
);

it.live(
  "closing a handle interrupts a pending RPC build without reviving its generation",
  () =>
    Effect.gen(function* () {
      const monitor = yield* reserve();
      const observer = yield* echo(monitor, "pending-build-observer");
      const initial = yield* observer.stats();
      const inspect = runAsFile(
        monitor,
        "pending-build-observer",
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).serverDiagnostics;
        }),
      );
      const baseline = yield* inspect;
      expect(baseline).toBeDefined();
      const first = yield* reserve();
      const pending = yield* runAsFile(
        first,
        "pending-build-stack",
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).get(BLOCKED_ECHO, "Test.Echo");
        }),
      ).pipe(Effect.forkChild);
      const building = yield* inspect.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: (counts) => counts?.building === baseline!.building + 1,
        }),
      );
      expect(building?.building).toBe(baseline!.building + 1);
      const acquired = yield* observer.stats().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: (stats) => stats.active === initial.active + 1,
        }),
      );
      expect(acquired.active).toBe(initial.active + 1);
      yield* first.close;
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      expect(yield* inspect).toEqual(baseline);
      expect((yield* observer.stats()).finalized).toBe(initial.finalized + 1);

      const successor = yield* reserve();
      const next = yield* echo(successor, "pending-build-stack");
      expect(yield* next.echo("new generation")).toBe("echo:new generation");
      yield* first.close;
      expect(yield* next.echo("still active")).toBe("echo:still active");
      yield* successor.close;
      expect(yield* inspect).toEqual(baseline);
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 60_000, exclusive: true },
);

it.live(
  "released files return session and provider counts to baseline without retaining artifacts",
  () =>
    Effect.gen(function* () {
      const monitor = yield* reserve();
      const observer = yield* echo(monitor, "session-count-observer");
      const baseline = yield* Core.sidecarDiagnostics;
      const inspect = runAsFile(
        monitor,
        "session-count-observer",
        Effect.gen(function* () {
          return yield* (yield* RpcProviderProxy).serverDiagnostics;
        }),
      );
      const serverBaseline = yield* inspect;
      const before = yield* observer.stats();
      for (let index = 0; index < 6; index++) {
        const handle = yield* reserve();
        const name = `session-release-${index}`;
        const provider = yield* echo(handle, name);
        expect(yield* provider.identity()).toEqual({ name, stage: "test" });
        yield* provider.retainArtifact();
        expect(yield* provider.artifactCount()).toBe(1);
        expect(yield* observer.artifactCount()).toBe(0);
        yield* handle.close;
        expect(yield* Core.sidecarDiagnostics).toEqual(baseline);
        expect(yield* inspect).toEqual(serverBaseline);
        expect(yield* observer.stats()).toEqual({
          active: before.active,
          built: before.built + index + 1,
          finalized: before.finalized + index + 1,
        });
      }
    }).pipe(Effect.scoped),
  { tags: ["local"], timeout: 90_000, exclusive: true },
);
