import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  type FilesystemEntryMetadata,
  type FilesystemGetMetadataInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createFileMetadataAtoms } from "./fileMetadata.ts";

const ENVIRONMENT_ID = EnvironmentId.make("metadata-environment");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("metadata-other-environment");

const makeHarness = Effect.fnUntraced(function* () {
  const batches: string[][] = [];
  const values = new Map<string, FilesystemEntryMetadata | null>();
  const failure = { denied: false };
  const makeSession = () =>
    ({
      client: {
        [WS_METHODS.filesystemGetMetadata]: (input: FilesystemGetMetadataInput) =>
          Effect.gen(function* () {
            batches.push([...input.paths]);
            if (failure.denied)
              return yield* new EnvironmentAuthorizationError({
                requiredScope: AuthFilesystemReadScope,
                message: "File access is not granted.",
              });
            return { entries: input.paths.map((path) => values.get(path) ?? null) };
          }),
      },
    }) as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(Option.some(makeSession()));
  const state = yield* SubscriptionRef.make({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected" as const,
  });
  const supervisor = {
    target: { environmentId: ENVIRONMENT_ID },
    session,
    state,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const otherSupervisor = {
    ...supervisor,
    target: { environmentId: OTHER_ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(Option.some(makeSession())),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const getSupervisor = (environmentId: EnvironmentId) =>
    environmentId === OTHER_ENVIRONMENT_ID ? otherSupervisor : supervisor;
  const environmentRegistry = {
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        getSupervisor(environmentId),
      ),
    followStream: (environmentId, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        getSupervisor(environmentId),
      ),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const atoms = createFileMetadataAtoms(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atom = (path: string, environmentId = ENVIRONMENT_ID) =>
    atoms.metadata({ environmentId, input: { path } });
  const read = (path: string, environmentId = ENVIRONMENT_ID) =>
    AtomRegistry.getResult(registry, atom(path, environmentId), { suspendOnWaiting: true }).pipe(
      Effect.tap(() => Effect.yieldNow),
    );
  const seed = (path: string, kind: "file" | "directory") =>
    atoms
      .rememberEntries("/workspace", [{ path, kind }])
      .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
  return {
    batches,
    values,
    registry,
    atom,
    read,
    seed,
    session,
    makeSession,
    atoms,
    supervisor,
    failure,
  };
});

describe("file metadata", () => {
  it.effect("keeps batches and cached paths separate across environments", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.seed("known", "directory");
      expect(yield* h.read("/workspace/known", OTHER_ENVIRONMENT_ID)).toBeNull();
      expect(h.batches).toEqual([["/workspace/known"]]);
      yield* Effect.all(
        [h.read("/workspace/new"), h.read("/workspace/new", OTHER_ENVIRONMENT_ID)],
        { concurrency: "unbounded" },
      );
      expect(h.batches.slice(1)).toEqual([["/workspace/new"], ["/workspace/new"]]);
    }).pipe(Effect.scoped),
  );

  it.effect("settles a failed batch and can retry after access is granted", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failure.denied = true;
      const failures = yield* Effect.all(
        [h.read("/workspace/a").pipe(Effect.flip), h.read("/workspace/b").pipe(Effect.flip)],
        { concurrency: "unbounded" },
      );
      expect(failures.every(Schema.is(EnvironmentAuthorizationError))).toBe(true);
      h.failure.denied = false;
      h.values.set("/workspace/a", { kind: "directory" });
      h.registry.refresh(h.atom("/workspace/a"));
      expect(yield* h.read("/workspace/a")).toEqual({ kind: "directory" });
    }).pipe(Effect.scoped),
  );

  it.effect("expires cached metadata and refreshes a changed kind", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.values.set("/workspace/path", { kind: "file" });
      yield* h.read("/workspace/path");
      h.values.set("/workspace/path", { kind: "directory" });
      yield* TestClock.adjust("61 seconds");
      h.registry.refresh(h.atom("/workspace/path"));
      expect(yield* h.read("/workspace/path")).toEqual({ kind: "directory" });
      expect(h.batches).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses file read sizes and normalizes Windows cache keys", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.atoms
        .rememberFile("C:\\Workspace", {
          relativePath: "file",
          byteLength: 100,
        })
        .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor));
      expect(yield* h.read("c:/workspace/file/")).toEqual({ kind: "file", byteLength: 100 });
      expect(h.batches).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("batches mounted paths and deduplicates repeated chips", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.values.set("/workspace/file", { kind: "file", byteLength: 5 });
      h.values.set("/workspace/folder.ts", { kind: "directory" });
      const results = yield* Effect.all(
        [h.read("/workspace/file"), h.read("/workspace/folder.ts"), h.read("/workspace/file")],
        { concurrency: "unbounded" },
      );
      expect(h.batches).toEqual([["/workspace/file", "/workspace/folder.ts"]]);
      expect(results).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "directory" },
        { kind: "file", byteLength: 5 },
      ]);
      yield* h.read("/workspace/file");
      expect(h.batches).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("uses search and tree kinds without another request", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.seed("folder.ts", "directory");
      expect(yield* h.read("/workspace/folder.ts")).toEqual({ kind: "directory" });
      expect(h.batches).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("splits large mounts into bounded batches and caches misses", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.all(
        Array.from({ length: 130 }, (_, i) => h.read(`/workspace/${i}`)),
        { concurrency: "unbounded" },
      );
      expect(h.batches.flat()).toHaveLength(130);
      expect(h.batches.every((batch) => batch.length <= 64)).toBe(true);
      const count = h.batches.length;
      yield* h.read("/workspace/0");
      expect(h.batches).toHaveLength(count);
    }).pipe(Effect.scoped),
  );

  it.effect("rechecks metadata after the environment session changes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.values.set("/workspace/path", { kind: "file" });
      expect(yield* h.read("/workspace/path")).toEqual({ kind: "file" });
      h.values.set("/workspace/path", { kind: "directory" });
      yield* SubscriptionRef.set(h.session, Option.some(h.makeSession()));
      h.registry.refresh(h.atom("/workspace/path"));
      expect(yield* h.read("/workspace/path")).toEqual({ kind: "directory" });
      expect(h.batches).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
