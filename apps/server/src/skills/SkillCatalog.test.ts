// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../provider/providerMaintenance.ts";
import { make } from "./SkillCatalog.ts";

function instance(
  id: string,
  skills: ReadonlyArray<ServerProviderSkill>,
  probe?: ProviderInstance["snapshotForCwd"],
): ProviderInstance {
  const driver = ProviderDriverKind.make("codex");
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(id),
    driver,
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills,
  };
  return {
    instanceId: snapshot.instanceId,
    driverKind: driver,
    displayName: id,
    enabled: true,
    continuationIdentity: { driverKind: driver, continuationKey: id },
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    ...(probe ? { snapshotForCwd: probe } : {}),
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}
const catalogFor = (instances: ProviderInstance[]) =>
  make().pipe(
    Effect.provide(
      Layer.mock(ProviderInstanceRegistry)({ listInstances: Effect.succeed(instances) }),
    ),
  );

it.effect(
  "keeps raw provider identity/status, groups symlinks, isolates environments and refreshes bounded reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-provider-skills-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const first = NodePath.join(root, "first.md");
        const second = NodePath.join(root, "second.md");
        const linked = NodePath.join(root, "linked.md");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(first, "---\nname: shared\n---\nFirst instructions");
          await NodeFSP.writeFile(second, "Second instructions");
          await NodeFSP.symlink(first, linked);
        });
        const aSkills = [
          { name: "same-name", path: first, enabled: false, userInvocationOnly: true },
        ];
        const a = instance("personal", aSkills);
        const b = instance("work", [
          { name: "alias", path: linked, enabled: true, userInvocable: false },
          { name: "same-name", path: second, enabled: true },
        ]);
        const catalog = yield* catalogFor([a, b]);
        const listed = yield* catalog.list();
        expect(listed.issues).toEqual([]);
        expect(listed.skills).toHaveLength(2);
        const shared = listed.skills.find((s) => s.installations.length === 2)!;
        expect(shared.resolvedPath).toBe(yield* Effect.promise(() => NodeFSP.realpath(first)));
        expect(
          shared.installations.map((s) => [
            s.instanceId,
            s.name,
            s.path,
            s.enabled,
            s.userInvocationOnly,
            s.userInvocable,
          ]),
        ).toEqual([
          ["personal", "same-name", first, false, true, undefined],
          ["work", "alias", linked, true, undefined, false],
        ]);
        const distinct = listed.skills.find((s) => s.id !== shared.id)!;
        expect(Option.getOrThrow(yield* catalog.detail(shared.id)).content).toBe(
          "First instructions",
        );
        expect(Option.getOrThrow(yield* catalog.detail(distinct.id)).content).toBe(
          "Second instructions",
        );
        expect(Option.isNone(yield* catalog.detail(second))).toBe(true);
        const otherEnvironment = yield* catalogFor([
          instance("personal", [{ name: "same-name", path: second, enabled: true }]),
        ]);
        expect(Option.isNone(yield* otherEnvironment.detail(shared.id))).toBe(true);
        // A new snapshot entry is picked up on refresh, without composer filtering.
        aSkills.push({
          name: "new-disabled",
          path: second,
          enabled: false,
          userInvocationOnly: true,
        });
        expect(
          (yield* catalog.list()).skills
            .flatMap((s) => s.installations)
            .some((s) => s.name === "new-disabled"),
        ).toBe(true);
        yield* Effect.promise(() => NodeFSP.writeFile(first, "Updated instructions"));
        yield* catalog.list();
        expect(Option.getOrThrow(yield* catalog.detail(shared.id)).content).toBe(
          "Updated instructions",
        );
        // A retargeted symlink must not change the instructions beneath cached badges.
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(linked);
          await NodeFSP.symlink(second, linked);
        });
        expect(Option.getOrThrow(yield* catalog.detail(shared.id)).content).toBe(
          "Updated instructions",
        );
        const refreshed = yield* catalog.list();
        expect(
          refreshed.skills
            .find((s) => s.id === distinct.id)
            ?.installations.some((s) => s.name === "alias"),
        ).toBe(true);
        yield* Effect.promise(() => NodeFSP.writeFile(first, "x".repeat(512 * 1024)));
        expect(Option.getOrThrow(yield* catalog.detail(shared.id)).content).toHaveLength(
          512 * 1024,
        );
        yield* Effect.promise(() => NodeFSP.appendFile(first, "x"));
        expect((yield* catalog.detail(shared.id).pipe(Effect.flip))._tag).toBe("SkillReadError");
      }),
    ),
);

it.effect("uses fresh workspace discovery and bounds and releases concurrent requests", () =>
  Effect.gen(function* () {
    let entered = yield* Deferred.make<void>();
    let release = yield* Deferred.make<void>();
    let runs = 0;
    let active = 0;
    const base = instance("personal", []);
    const provider = instance("personal", [], () =>
      Effect.gen(function* () {
        runs++;
        active++;
        if (active === 2) yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* base.snapshot.getSnapshot;
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            active--;
          }),
        ),
      ),
    );
    const catalog = yield* catalogFor([provider]);
    const first = yield* catalog.list("/a").pipe(Effect.forkChild);
    const second = yield* catalog.list("/b").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect((yield* catalog.list("/c").pipe(Effect.flip))._tag).toBe("SkillDiscoveryError");
    expect(runs).toBe(2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* catalog.list("/a");
    expect(runs).toBe(3);
    entered = yield* Deferred.make<void>();
    release = yield* Deferred.make<void>();
    const abandoned = yield* catalog.list("/a").pipe(Effect.forkChild);
    const other = yield* catalog.list("/b").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(abandoned);
    yield* Fiber.interrupt(other);
    expect(active).toBe(0);
    yield* Deferred.succeed(release, undefined);
    expect((yield* catalog.list("/a")).skills).toEqual([]);
  }),
);
