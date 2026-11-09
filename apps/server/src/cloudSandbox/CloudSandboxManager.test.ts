import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { CloudSandboxRenewalsEnabled } from "./CloudSandboxManager.ts";
import { expect, it } from "@effect/vitest";
import { ManagedCloudSandboxResourceId, SandboxProfileId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { fixture } from "./CloudSandboxManager.testkit.ts";

it.effect("preserves resource intent, reuses live transport and keeps source grants stable", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("sandbox");
    const input = {
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    } as const;
    const first = yield* manager.provision(input);
    expect((yield* manager.connect(id)).connection).toEqual(first.connection);
    expect((yield* manager.provision(input)).pairingToken).toBe("fresh-peer-token");
    expect(f.connections()).toBe(1);
    const grant = Hex.encode(f.values.get(`cloud-source-${id}`)!);
    yield* manager.disconnect(id);
    yield* manager.connect(id);
    expect((yield* manager.sourceContext(id, grant)).resourceId).toBe(id);
    expect(Hex.encode(f.values.get(`cloud-source-${id}`)!)).toBe(grant);
    const mismatch = yield* manager
      .provision({ ...input, sandbox: { ...input.sandbox, name: "renamed" } })
      .pipe(Effect.result);
    expect(mismatch._tag).toBe("Failure");
    expect(
      (yield* manager
        .execute(id, {
          _tag: "recordingStop",
          recordingId: ManagedCloudSandboxResourceId.make("foreign-recording"),
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect((yield* manager.artifact(id, "foreign-recording").pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    const resource = yield* manager.get(id);
    expect(resource.recordingIds).toEqual([]);
    expect(resource).not.toHaveProperty("apiKey");
  }).pipe(Effect.scoped),
);

it.effect("reconnects a cached route only after two consecutive failed health probes", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("stale");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    f.setHealthy(false);
    yield* manager.reconcile;
    expect(f.connections()).toBe(1);
    expect((yield* manager.route(id).pipe(Effect.result))._tag).toBe("Success");
    yield* manager.reconcile;
    expect(f.connections()).toBe(2);
    expect(f.connectionInputs.at(-1)?.allowResume).toBe(false);
    expect((yield* manager.get(id)).phase).toBe("connected");
  }).pipe(Effect.scoped),
);

it.effect("answers route from memory without provider calls or health probes", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("route-memory");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    const requests = f.requests();
    const healthChecks = f.healthChecks();
    yield* Effect.forEach(Array.from({ length: 5 }), () => manager.route(id));
    expect(f.requests()).toBe(requests);
    expect(f.healthChecks()).toBe(healthChecks);
    expect(f.connections()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("fails route after a user disconnect without changing the disconnected phase", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("route-disconnected");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    yield* manager.disconnect(id);
    const connections = f.connections();
    expect(yield* manager.route(id).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "transport" },
    });
    expect((yield* manager.get(id)).phase).toBe("disconnected");
    expect(f.connections()).toBe(connections);
  }).pipe(Effect.scoped),
);

it.effect(
  "fails route for an unknown id with the same transport reason as an unconnected one",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.manager;
      expect(
        yield* manager
          .route(ManagedCloudSandboxResourceId.make("never-provisioned"))
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "transport" } });
      expect(f.connections()).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("marks a connected record stopped on restart without resuming its VM", () =>
  Effect.gen(function* () {
    const original = fixture();
    const first = yield* original.manager;
    const id = ManagedCloudSandboxResourceId.make("restart-stopped");
    yield* first.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    const restarted = fixture();
    for (const [key, value] of original.records) restarted.records.set(key, value);
    for (const [key, value] of original.values) restarted.values.set(key, value);
    restarted.setState("stopped");
    const recovered = yield* restarted.manager;
    yield* recovered.reconcile;
    expect((yield* recovered.get(id)).phase).toBe("stopped");
    expect(restarted.resumes()).toBe(0);
    expect(restarted.connections()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("stops a live route when its VM stops, and later reconciles leave it alone", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("live-route-stops");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    f.setState("stopped");
    yield* manager.reconcile;
    expect((yield* manager.get(id)).phase).toBe("stopped");
    expect(yield* manager.route(id).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "transport" },
    });
    expect(f.resumes()).toBe(0);
    const requests = f.requests();
    yield* manager.reconcile;
    expect(f.requests()).toBe(requests);
    expect(f.connections()).toBe(1);
    expect((yield* manager.get(id)).phase).toBe("stopped");
  }).pipe(Effect.scoped),
);

it.effect("resumes a stopped VM only for an explicit execute resume", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("explicit-resume");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    f.setState("stopped");
    expect(yield* manager.execute(id, { _tag: "resume" })).toMatchObject({
      _tag: "status",
      sandbox: { state: "ready" },
    });
    expect(f.resumes()).toBe(1);
    expect(f.connections()).toBe(2);
    expect((yield* manager.get(id)).phase).toBe("connected");
  }).pipe(Effect.scoped),
);

it.effect("keeps public connect from waking a stopped VM", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("public-connect-stopped");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    yield* manager.disconnect(id);
    f.setState("stopped");
    expect(yield* manager.connect(id).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "transport" },
    });
    expect((yield* manager.get(id)).phase).toBe("stopped");
    expect(f.resumes()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("leaves a failed create to explicit retries and re-checks the budget on retry", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const profile = SandboxProfileId.make("fixture");
    const id = ManagedCloudSandboxResourceId.make("failed-create");
    const input = {
      operationId: id,
      profile,
      sandbox: { name: "failed", size: "small", autoStopMinutes: 15 },
    } as const;
    let creates = 0;
    f.setResponse((url, method) => {
      if (method !== "POST" || !url.endsWith("/sandboxes")) return undefined;
      creates++;
      return creates === 1 ? Response.json({ message: "unavailable" }, { status: 500 }) : undefined;
    });
    expect((yield* manager.provision(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(f.records.get(id)?.lifecycle).toBe("failed");
    expect(f.records.get(id)?.sandboxId).toBeNull();
    yield* manager.reconcile;
    expect(creates).toBe(1);
    expect(f.records.get(id)?.lifecycle).toBe("failed");
    f.setBudget(1);
    f.setSpend(profile, 1);
    expect(yield* manager.provision(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "budget" },
    });
    expect(creates).toBe(1);
    f.setBudget(100);
    expect((yield* manager.provision(input).pipe(Effect.result))._tag).toBe("Success");
    expect(creates).toBe(2);
    expect((yield* manager.get(id)).phase).toBe("connected");
  }).pipe(Effect.scoped),
);

it.effect("stops the VM despite a failed recording intent with no provider metadata", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("recording-failure");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    expect(
      (yield* manager
        .execute(id, {
          _tag: "recordingStart",
          recordingId: ManagedCloudSandboxResourceId.make("failed-start"),
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* manager.execute(id, { _tag: "stop" });
    expect(f.stops()).toBe(1);
    expect((yield* manager.get(id)).phase).toBe("stopped");
    expect((yield* manager.get(id)).recordingIds).toEqual(["failed-start"]);
  }).pipe(Effect.scoped),
);

it.effect("refuses source grants that target their own source or unrelated resources", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("source");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    const token = Hex.encode(f.values.get(`cloud-source-${id}`)!);
    const bad = yield* manager.sourceContext(id, "wrong").pipe(Effect.result);
    expect(bad._tag).toBe("Failure");
    const self = yield* manager
      .executeSource(id, token, { _tag: "delete", resourceId: id })
      .pipe(Effect.result);
    expect(self._tag).toBe("Failure");
    const record = f.records.get(id)!;
    const unrelated = ManagedCloudSandboxResourceId.make("unrelated");
    f.records.set(unrelated, {
      ...record,
      resourceId: unrelated,
      parentResourceId: null,
    });
    const foreign = yield* manager
      .executeSource(id, token, { _tag: "connect", resourceId: unrelated })
      .pipe(Effect.result);
    expect(foreign._tag).toBe("Failure");
    for (const operation of [
      { _tag: "get", resourceId: unrelated },
      { _tag: "status", resourceId: unrelated },
    ] as const) {
      expect((yield* manager.executeSource(id, token, operation).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }
    const owned = ManagedCloudSandboxResourceId.make("owned");
    f.records.set(owned, {
      ...record,
      resourceId: owned,
      parentResourceId: id,
    });
    expect(
      yield* manager.executeSource(id, token, { _tag: "get", resourceId: owned }),
    ).toMatchObject({
      _tag: "resource",
      resource: { resourceId: owned },
    });
    f.setState("stopped");
    expect(
      yield* manager.executeSource(id, token, { _tag: "status", resourceId: owned }),
    ).toMatchObject({
      _tag: "result",
      result: { _tag: "status", sandbox: { state: "stopped" } },
    });
    expect(f.connections()).toBe(1);

    const deleting = ManagedCloudSandboxResourceId.make("deleting-child");
    f.records.set(deleting, {
      ...record,
      resourceId: deleting,
      parentResourceId: id,
      lifecycle: "deleting",
      power: "stopped",
    });
    expect(
      (yield* manager
        .executeSource(id, token, { _tag: "connect", resourceId: deleting })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(f.records.get(deleting)).toMatchObject({ lifecycle: "deleting", power: "stopped" });
  }).pipe(Effect.scoped),
);

it.effect("a source connect queued behind a child stop re-checks the profile's limits", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const source = ManagedCloudSandboxResourceId.make("queue-source");
    yield* manager.provision({
      operationId: source,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "source", size: "small", autoStopMinutes: 15 },
    });
    const token = Hex.encode(f.values.get(`cloud-source-${source}`)!);
    const child = ManagedCloudSandboxResourceId.make("queue-child");
    f.records.set(child, {
      ...f.records.get(source)!,
      resourceId: child,
      parentResourceId: source,
    });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setBeforeRequest((url) =>
      url.includes("/stop")
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    const stopping = yield* manager
      .execute(child, { _tag: "stop" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    // Runs until it waits on the child's lock, which the stop holds.
    const connecting = yield* manager
      .executeSource(source, token, { _tag: "connect", resourceId: child })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    // The source alone now fills the profile, so resuming the child would exceed it.
    f.setMaxConcurrent(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stopping);
    expect(yield* Fiber.join(connecting)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "concurrency" },
    });
    expect(f.records.get(child)).toMatchObject({ power: "stopped" });
  }).pipe(Effect.scoped),
);

it.effect(
  "stops a newly allocated sandbox when transport setup fails and retains the record for cleanup",
  () =>
    Effect.gen(function* () {
      const f = fixture(true);
      const manager = yield* f.manager;
      const id = ManagedCloudSandboxResourceId.make("created");
      const result = yield* manager
        .provision({
          operationId: id,
          profile: SandboxProfileId.make("fixture"),
          sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
          enableLinkedEnvironments: true,
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(f.stops()).toBe(1);
      expect(f.records.get(id)?.sandboxId).toBe("bx_23456789");
      expect(f.records.get(id)?.lifecycle).toBe("deleting");
      expect(f.records.get(id)?.enableLinkedEnvironments).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect("never reconnects a deleted resource or accepts a changed fork intent", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("terminal");
    const input = {
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    } as const;
    yield* manager.provision(input);
    const original = f.records.get(id)!;
    f.records.set(id, { ...original, lifecycle: "deleted" });
    expect(yield* manager.connect(id).pipe(Effect.flip)).toMatchObject({ reason: "deleted" });
    const child = ManagedCloudSandboxResourceId.make("child-intent");
    f.records.set(child, {
      ...original,
      resourceId: child,
      parentResourceId: id,
      label: "first",
      selection: {
        requestId: child,
        template: `t3-${child}`,
        name: "first",
        size: "small",
        autoStopMinutes: 15,
      },
    });
    expect(
      (yield* manager
        .fork({ sourceResourceId: id, operationId: child, name: "changed" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(f.connections()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "recovers a persisted connection after controller restart without another allocation",
  () =>
    Effect.gen(function* () {
      const original = fixture();
      const first = yield* original.manager;
      const id = ManagedCloudSandboxResourceId.make("restart");
      yield* first.provision({
        operationId: id,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
      });
      const saved = original.records.get(id)!;
      original.records.set(id, { ...saved, recordingIds: ["owned-recording"] });
      const restarted = fixture();
      for (const [key, value] of original.records) restarted.records.set(key, value);
      for (const [key, value] of original.values) restarted.values.set(key, value);
      const recovered = yield* restarted.manager;
      yield* recovered.reconcile;
      expect(restarted.connections()).toBe(1);
      expect(restarted.records.get(id)?.sandboxId).toBe("bx_23456789");
      expect(yield* recovered.get(id)).toMatchObject({ recordingIds: ["owned-recording"] });
      expect(yield* recovered.list).toEqual([yield* recovered.get(id)]);
      expect(restarted.connections()).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "disables renewal independently of auto-resume across the live fixture's 900-second lifetime",
  () =>
    Effect.gen(function* () {
      const probes = yield* Queue.unbounded<void>();
      const f = fixture(false, Effect.void, {
        active: true,
        probe: Queue.offer(probes, undefined).pipe(Effect.asVoid),
      });
      const manager = yield* f.manager.pipe(
        Effect.provideService(CloudSandboxRenewalsEnabled, false),
      );
      const id = ManagedCloudSandboxResourceId.make("bounded-live-fixture");
      yield* manager.provision({
        operationId: id,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
      });
      yield* TestClock.adjust("900 seconds");
      expect(f.extensions()).toBe(0);
      expect(yield* Queue.size(probes)).toBe(0);
      expect(
        (yield* manager.execute(id, { _tag: "extend", hours: 1 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* manager.disconnect(id);
      yield* manager.connect(id);
      const restarted = yield* f.manager.pipe(
        Effect.provideService(CloudSandboxRenewalsEnabled, false),
      );
      yield* restarted.reconcile;
      yield* TestClock.adjust("900 seconds");
      expect(f.extensions()).toBe(0);
      expect(yield* Queue.size(probes)).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect(
  "renews short autoStopMinutes sandboxes before expiry and preserves multi-hour autoStopMinutes",
  () =>
    Effect.gen(function* () {
      const probes = yield* Queue.unbounded<void>();
      const f = fixture(false, Effect.void, {
        active: true,
        probe: Queue.offer(probes, undefined).pipe(Effect.asVoid),
      });
      const manager = yield* f.manager;
      const shortId = ManagedCloudSandboxResourceId.make("short-ttl");
      yield* manager.provision({
        operationId: shortId,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "short", size: "small", autoStopMinutes: 15 },
      });
      yield* Queue.take(probes);
      expect(f.extensionTtls()).toEqual([3600]);
      for (let minute = 0; minute < 7; minute++) {
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(probes);
      }
      expect(f.extensionTtls()).toEqual([3600, 3600]);
      yield* manager.disconnect(shortId);

      const longId = ManagedCloudSandboxResourceId.make("long-ttl");
      yield* manager.provision({
        operationId: longId,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "long", size: "small", autoStopMinutes: 480 },
      });
      yield* Queue.take(probes);
      expect(f.extensionTtls()).toEqual([3600, 3600, 28_800]);
      yield* manager.disconnect(longId);
    }).pipe(Effect.scoped),
);

it.effect("serializes recording intent behind stop and preserves terminal deletion", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("race");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "race", size: "small", autoStopMinutes: 15 },
    });
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    f.setBeforeRequest((url) =>
      url.includes("/stop")
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
        : Effect.void,
    );
    const stopping = yield* manager.execute(id, { _tag: "stop" }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const recording = yield* manager
      .execute(id, {
        _tag: "recordingStart",
        recordingId: ManagedCloudSandboxResourceId.make("intent"),
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(stopping);
    yield* Fiber.join(recording);
    expect((yield* manager.get(id)).recordingIds).toEqual(["intent"]);
    f.records.set(id, { ...f.records.get(id)!, lifecycle: "deleted" });
    yield* manager.disconnect(id);
    expect((yield* manager.get(id)).phase).toBe("deleted");
    expect((yield* manager.execute(id, { _tag: "stop" }).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.effect.each(["missing", "saving", "ready", "ambiguous"] as const)(
  "recovers snapshot capture intent after crash: %s",
  (snapshotState) =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.manager;
      const source = ManagedCloudSandboxResourceId.make("snapshot-source");
      yield* manager.provision({
        operationId: source,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
      });
      const child = ManagedCloudSandboxResourceId.make("snapshot-child");
      const name = `t3-${child}`;
      f.records.set(child, {
        ...f.records.get(source)!,
        resourceId: child,
        parentResourceId: source,
        sandboxId: null,
        environmentId: null,
        lifecycle: "allocating",
        snapshotName: name,
        snapshotReady: false,
        selection: {
          template: name,
          name: "child",
          size: "small",
          autoStopMinutes: 15,
        },
      });
      let captures = 0;
      let reads = 0;
      f.setResponse((url, method) => {
        if (!url.includes("saved-snapshots")) return undefined;
        if (method === "DELETE") return Response.json({ ok: true });
        if (method === "POST") captures++;
        if (method === "GET" && reads++ === 0) {
          if (snapshotState === "missing")
            return Response.json({ error: "missing" }, { status: 404 });
          if (snapshotState === "ambiguous")
            return Response.json({ error: "network" }, { status: 503 });
        }
        return Response.json({
          ok: true,
          snapshot: {
            name,
            status:
              method === "GET" && reads === 1 && snapshotState === "saving" ? "saving" : "ready",
            sourceSandboxId: "bx_23456789",
          },
        });
      });
      const result = yield* manager
        .fork({
          sourceResourceId: source,
          operationId: child,
          name: "child",
          size: "small",
          autoStopMinutes: 15,
        })
        .pipe(Effect.result);
      expect(result._tag).toBe(snapshotState === "ambiguous" ? "Failure" : "Success");
      expect(captures).toBe(snapshotState === "missing" ? 1 : 0);
    }).pipe(Effect.scoped),
);

it.effect("enforces allocation budgets while preserving accepted retries", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const source = ManagedCloudSandboxResourceId.make("budget-source");
    const profile = SandboxProfileId.make("fixture");
    const input = {
      operationId: source,
      profile,
      sandbox: { name: "source", size: "small", autoStopMinutes: 15 },
      enableLinkedEnvironments: true,
    } as const;
    yield* manager.provision(input);
    f.setBudget(1);
    f.setSpend(profile, 1);
    const blocked = yield* manager
      .fork({
        sourceResourceId: source,
        operationId: ManagedCloudSandboxResourceId.make("over-budget"),
        name: "child",
      })
      .pipe(Effect.result);
    expect(blocked).toMatchObject({ _tag: "Failure", failure: { reason: "budget" } });
    expect(f.records.has("over-budget")).toBe(false);
    expect((yield* manager.provision(input).pipe(Effect.result))._tag).toBe("Success");
    const fresh = yield* manager
      .provision({
        ...input,
        operationId: ManagedCloudSandboxResourceId.make("fresh-over-budget"),
      })
      .pipe(Effect.result);
    expect(fresh).toMatchObject({ _tag: "Failure", failure: { reason: "budget" } });
    f.setSpend(profile, Number.NaN);
    const corruptedBudget = yield* manager
      .provision({
        ...input,
        operationId: ManagedCloudSandboxResourceId.make("nan-budget"),
      })
      .pipe(Effect.result);
    expect(corruptedBudget).toMatchObject({ _tag: "Failure", failure: { reason: "budget" } });
  }).pipe(Effect.scoped),
);

it.effect(
  "blocks hosting MANAGED_CLOUD_SOURCE_PORT or invalid ports and attributes spend safely before provider deletion",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.manager;
      const profile = SandboxProfileId.make("fixture");
      const id = ManagedCloudSandboxResourceId.make("host-guard");
      yield* manager.provision({
        operationId: id,
        profile,
        sandbox: { name: "host-guard", size: "small", autoStopMinutes: 15 },
      });
      const token = Hex.encode(f.values.get(`cloud-source-${id}`)!);
      for (const badPort of [47773, 0, -1, 70_000]) {
        expect(
          yield* manager
            .execute(id, { _tag: "host", port: badPort, isPublic: false })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "ownership" } });
        expect(
          yield* manager
            .executeSource(id, token, { _tag: "host", port: badPort })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "ownership" } });
      }
      const makeDeletionCompleted = () =>
        Response.json({
          ok: true,
          operation: {
            id: "op_del_1",
            kind: "sandbox",
            targetId: "bx_23456789",
            status: "completed",
          },
        });
      let deletedOnProvider = false;
      f.setResponse((url, method) => {
        if (url.endsWith("/usage")) {
          return deletedOnProvider
            ? Response.json({ message: "Sandbox already deleted" }, { status: 404 })
            : Response.json({
                ok: true,
                sandboxId: "bx_23456789",
                sandboxType: "small",
                billingMultiplier: 1,
                seconds: 600,
                dollars: 1.25,
                secondsPerDollar: 480,
                running: false,
                since: "2026-01-01T00:00:00Z",
                until: "2026-01-01T00:10:00Z",
              });
        }
        if (
          (method === "DELETE" && url.includes("/sandboxes/")) ||
          url.includes("/deletion-operations/")
        ) {
          deletedOnProvider = true;
          return makeDeletionCompleted();
        }
        return undefined;
      });
      yield* manager.release(id);
      expect(f.spent(profile)).toBe(1.25);
      expect((yield* manager.get(id)).phase).toBe("deleted");

      const badCreatedAt = ManagedCloudSandboxResourceId.make("bad-created-at");
      deletedOnProvider = false;
      f.setResponse(() => undefined);
      yield* manager.provision({
        operationId: badCreatedAt,
        profile,
        sandbox: { name: "bad-created-at", size: "small", autoStopMinutes: 15 },
      });
      f.setResponse((url, method) => {
        if (url.endsWith("/usage")) {
          return Response.json({ message: "unavailable" }, { status: 503 });
        }
        if (
          (method === "DELETE" && url.includes("/sandboxes/")) ||
          url.includes("/deletion-operations/")
        ) {
          return makeDeletionCompleted();
        }
        if (method === "GET" && url.includes("/sandboxes/")) {
          return Response.json({
            ok: true,
            sandbox: {
              id: "bx_23456789",
              name: "bad-created-at",
              state: "ready",
              type: "small",
              hourlyRateUsd: 2,
              createdAt: "not-a-timestamp",
            },
          });
        }
        return undefined;
      });
      yield* manager.release(badCreatedAt);
      expect((yield* manager.get(badCreatedAt)).phase).toBe("deleted");
    }).pipe(Effect.scoped),
);

it.effect("shows a provider stop of a user-disconnected sandbox, then a resume reconnects it", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("disconnect-then-stop");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    yield* manager.disconnect(id);
    f.setState("stopped");
    expect(yield* manager.connect(id).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "transport" },
    });
    expect((yield* manager.get(id)).phase).toBe("stopped");
    expect(f.records.get(id)).toMatchObject({ power: "stopped", intent: "disconnected" });
    expect(yield* manager.execute(id, { _tag: "resume" })).toMatchObject({
      _tag: "status",
      sandbox: { state: "ready" },
    });
    expect((yield* manager.get(id)).phase).toBe("connected");
    expect(f.records.get(id)).toMatchObject({ power: "running", intent: "connected" });
  }).pipe(Effect.scoped),
);

it.effect("refuses new allocations past the profile's concurrent sandbox limit", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.setMaxConcurrent(2);
    const manager = yield* f.manager;
    const provisionNew = (id: string) =>
      manager.provision({
        operationId: ManagedCloudSandboxResourceId.make(id),
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: id, size: "small", autoStopMinutes: 15 },
      });
    yield* provisionNew("cap-one");
    yield* provisionNew("cap-two");
    expect(yield* provisionNew("cap-three").pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "concurrency" },
    });
    expect(f.records.has("cap-three")).toBe(false);

    const capOne = ManagedCloudSandboxResourceId.make("cap-one");
    yield* manager.execute(capOne, { _tag: "stop" });
    yield* provisionNew("cap-three");
    expect(yield* manager.execute(capOne, { _tag: "resume" }).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "concurrency" },
    });
    expect(yield* provisionNew("cap-one").pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "concurrency" },
    });
    expect(f.records.get(capOne)).toMatchObject({ power: "stopped" });
  }).pipe(Effect.scoped),
);

it.effect("admits only the concurrent allocations the budget reservation allows", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.setBudget(0.01);
    f.setResponse((url) =>
      url.endsWith("/usage")
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : undefined,
    );
    const manager = yield* f.manager;
    const results = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => index),
      (index) =>
        manager
          .provision({
            operationId: ManagedCloudSandboxResourceId.make(`budget-race-${index}`),
            profile: SandboxProfileId.make("fixture"),
            sandbox: { name: `race-${index}`, size: "small", autoStopMinutes: 15 },
          })
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(2);
    expect(
      results.flatMap((result) => (result._tag === "Failure" ? [result.failure.reason] : [])),
    ).toEqual(["budget", "budget", "budget", "budget", "budget", "budget"]);
  }).pipe(Effect.scoped),
);

it.effect("sends the profile's current credential on driver calls after rotation", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("rotate");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    yield* manager.execute(id, { _tag: "get" });
    expect(f.authorizations().at(-1)).toBe("Bearer key");
    f.setApiKey("rotated-key");
    yield* manager.execute(id, { _tag: "get" });
    expect(f.authorizations().at(-1)).toBe("Bearer rotated-key");
  }).pipe(Effect.scoped),
);

it.effect("records a failed release's lifetime spend once when the retry completes", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const profile = SandboxProfileId.make("fixture");
    const id = ManagedCloudSandboxResourceId.make("release-retry");
    yield* manager.provision({
      operationId: id,
      profile,
      sandbox: { name: "retry", size: "small", autoStopMinutes: 15 },
    });
    let deletionAccepted = false;
    const completedDeletion = {
      ok: true,
      operation: {
        id: "op_del_retry",
        kind: "sandbox",
        targetId: "bx_23456789",
        status: "completed",
      },
    };
    f.setResponse((url, method) => {
      if (url.endsWith("/usage")) {
        return Response.json({
          ok: true,
          sandboxId: "bx_23456789",
          sandboxType: "small",
          billingMultiplier: 1,
          seconds: 600,
          dollars: 1.25,
          secondsPerDollar: 480,
          running: false,
          since: "2026-01-01T00:00:00Z",
          until: "2026-01-01T00:10:00Z",
        });
      }
      if (method === "DELETE" && url.includes("/sandboxes/")) {
        return deletionAccepted
          ? Response.json(completedDeletion)
          : Response.json({ message: "forbidden" }, { status: 403 });
      }
      if (url.includes("/deletion-operations/")) return Response.json(completedDeletion);
      return undefined;
    });
    expect((yield* manager.release(id).pipe(Effect.result))._tag).toBe("Failure");
    deletionAccepted = true;
    yield* manager.release(id);
    expect(f.spent(profile)).toBe(1.25);
    expect((yield* manager.get(id)).phase).toBe("deleted");
  }).pipe(Effect.scoped),
);

it.effect("keeps retrying a working sandbox whose reconnect fails during an outage", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("outage");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    f.setHealthy(false);
    f.setConnectFails(true);
    yield* manager.reconcile;
    yield* manager.reconcile;
    expect((yield* manager.get(id)).phase).toBe("connecting");
    f.setConnectFails(false);
    yield* manager.reconcile;
    expect((yield* manager.get(id)).phase).toBe("connected");
    expect((yield* manager.route(id)).connection.resourceId).toBe(id);
    expect(f.resumes()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("keeps a reclaimed sandbox in the budget until its VM is deleted", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    f.setBudget(0.006);
    const manager = yield* f.manager;
    const provision = (name: string) =>
      manager.provision({
        operationId: ManagedCloudSandboxResourceId.make(name),
        profile: SandboxProfileId.make("fixture"),
        sandbox: { requestId: name, name, size: "small", autoStopMinutes: 15 },
      });
    expect((yield* provision("first").pipe(Effect.result))._tag).toBe("Failure");
    expect(f.records.get("first")?.lifecycle).toBe("deleting");
    expect(f.records.get("first")?.sandboxId).not.toBeNull();
    expect(f.records.get("first")?.power).toBe("stopped");
    f.setConnectFails(false);
    const second = yield* provision("second").pipe(Effect.result);
    expect(second).toMatchObject({ _tag: "Failure", failure: { reason: "budget" } });
  }).pipe(Effect.scoped),
);

it.effect("notices a provider stop of a user-disconnected sandbox without reconnecting it", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const id = ManagedCloudSandboxResourceId.make("parked");
    yield* manager.provision({
      operationId: id,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { requestId: "parked", name: "parked", size: "small", autoStopMinutes: 15 },
    });
    yield* manager.disconnect(id);
    const connections = f.connections();
    f.setState("stopped");
    yield* manager.reconcile;
    expect((yield* manager.get(id)).phase).toBe("stopped");
    expect(f.connections()).toBe(connections);
    expect(f.resumes()).toBe(0);
  }).pipe(Effect.scoped),
);
