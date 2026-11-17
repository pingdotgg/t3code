import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemWriteScope,
  EnvironmentId,
  ProjectId,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ThreadId,
  type AuthSessionState,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE, BearerConnectionTarget } from "../connection/model.ts";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const decodeReadFileInput = Schema.decodeUnknownSync(ProjectReadFileInput);
const decodeReadFileResult = Schema.decodeUnknownSync(ProjectReadFileResult);
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const PROJECT_ID = ProjectId.make("scratch");
const PROJECT = {
  id: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: "/scratch",
} as EnvironmentProject;

const makeHarness = Effect.fn("TestProjectCommands.makeHarness")(function* () {
  const metadataRequests: string[][] = [];
  const file = { byteLength: 5 };
  const readResponse = {
    wait: Effect.void as Effect.Effect<void, ProjectReadFileError>,
    missing: false,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.projectsEnsureScratch]: () => Effect.succeed({ projectId: PROJECT_ID }),
          [WS_METHODS.projectsReadFile]: () =>
            Effect.gen(function* () {
              const byteLength = file.byteLength;
              yield* readResponse.wait;
              return decodeReadFileResult(
                readResponse.missing
                  ? {
                      relativePath: "foo",
                      byteLength: 0,
                      contents: "",
                      truncated: false,
                      exists: false,
                    }
                  : { relativePath: "foo", byteLength, contents: "old", truncated: false },
              );
            }),
          [WS_METHODS.projectsWriteFile]: () =>
            Effect.sync(() => {
              file.byteLength = 10;
              return { relativePath: "foo" };
            }),
          [WS_METHODS.filesystemGetMetadata]: (input: { paths: string[] }) =>
            Effect.sync(() => {
              metadataRequests.push(input.paths);
              return {
                entries: input.paths.map(() =>
                  readResponse.missing
                    ? null
                    : { kind: "file" as const, byteLength: file.byteLength },
                ),
              };
            }),
        },
      } as unknown as RpcSession),
    ),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size)),
      ),
    ),
  );
  const storedProject = Atom.make<EnvironmentProject | null>(null);
  const commands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: (ref: ScopedProjectRef) =>
      ref.environmentId === ENVIRONMENT_ID && ref.projectId === PROJECT_ID
        ? storedProject
        : Atom.make(null),
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(
    sessions(ENVIRONMENT_ID),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthFilesystemWriteScope],
      permissions: [AuthFilesystemWriteScope],
    }),
  );
  const openScratch = Effect.promise(() =>
    commands.openScratch.run(registry, { environmentId: ENVIRONMENT_ID, input: {} }),
  );
  return { registry, storedProject, openScratch, commands, metadataRequests, readResponse };
});

describe("writeFile metadata", () => {
  it.effect("retires a saved overlay after an equal read succeeds, preserving newer drafts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const target = { environmentId: ENVIRONMENT_ID, cwd: "/repo", relativePath: "foo" };
      const query = h.commands.readFile({
        environmentId: ENVIRONMENT_ID,
        input: { cwd: target.cwd, relativePath: target.relativePath },
      });
      h.registry.mount(query);
      const read = () => AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
      const original = yield* read();
      const overlay = h.commands.optimisticFile(target);
      h.registry.mount(overlay);
      const saved = { ...original, contents: "saved" };
      h.registry.set(overlay, { data: saved, saved: true, confirmingQuery: query });
      h.readResponse.wait = Effect.fail(
        new ProjectReadFileError({
          cwd: "/repo",
          relativePath: "foo",
          failure: "operation_failed",
        }),
      );
      h.registry.refresh(query);
      yield* Effect.exit(read());
      expect(h.registry.get(overlay)?.data.contents).toBe("saved");

      h.readResponse.wait = Effect.void;
      h.registry.refresh(query);
      const refreshed = yield* read();
      // The production query shares equal file values across this failed confirmation.
      expect(refreshed).toBe(original);
      expect(h.registry.get(overlay)).toBeNull();

      h.registry.set(overlay, { data: { ...saved, contents: "newer draft" }, saved: false });
      h.registry.refresh(query);
      yield* read();
      expect(h.registry.get(overlay)?.data.contents).toBe("newer draft");
    }),
  );

  it.effect.each([true, false])(
    "keeps a saved overlay when an older read uses different allowMissing options (confirmation: %s)",
    (allowMissing) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const target = { environmentId: ENVIRONMENT_ID, cwd: "/repo", relativePath: "foo" };
        const query = h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: {
            cwd: target.cwd,
            relativePath: target.relativePath,
            ...(allowMissing ? { allowMissing: true } : {}),
          },
        });
        const otherQuery = h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: {
            cwd: target.cwd,
            relativePath: target.relativePath,
            ...(!allowMissing ? { allowMissing: true } : {}),
          },
        });
        const read = (atom: typeof query) =>
          AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        h.registry.mount(query);
        const original = yield* read(query);
        const overlay = h.commands.optimisticFile(target);
        h.registry.mount(overlay);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        h.registry.mount(otherQuery);
        const olderRead = yield* read(otherQuery).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        h.registry.set(overlay, {
          data: { ...original, contents: "saved" },
          saved: true,
          confirmingQuery: query,
        });
        h.readResponse.wait = Effect.fail(
          new ProjectReadFileError({
            cwd: target.cwd,
            relativePath: target.relativePath,
            failure: "operation_failed",
          }),
        );
        h.registry.refresh(query);
        yield* Effect.exit(read(query));
        expect(h.registry.get(overlay)?.data.contents).toBe("saved");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(olderRead);
        expect(h.registry.get(overlay)?.data.contents).toBe("saved");
        expect(Option.getOrNull(AsyncResult.value(h.registry.get(query)))).toBe(original);

        h.readResponse.wait = Effect.void;
        h.registry.refresh(query);
        expect(yield* read(query)).toBe(original);
        expect(h.registry.get(overlay)).toBeNull();
      }),
  );

  it.effect("preserves optional read results without seeding metadata for an absent file", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.readResponse.missing = true;
      const input = { cwd: "/repo", relativePath: "foo", allowMissing: true };
      expect.soft(decodeReadFileInput(input)).toEqual(input);
      const result = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({ environmentId: ENVIRONMENT_ID, input }),
        { suspendOnWaiting: true },
      );
      expect.soft(result).toEqual({
        relativePath: "foo",
        byteLength: 0,
        contents: "",
        truncated: false,
        exists: false,
      });
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo" },
      });
      expect(
        yield* AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true }),
      ).toBeNull();
      expect(h.metadataRequests).toEqual([["/repo/foo"]]);
    }),
  );

  it.effect("does not restore old metadata from a read completed after a write", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("stale-read-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo", threadId },
      });
      h.registry.mount(metadata);
      const readMetadata = () =>
        AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true });
      yield* readMetadata();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const fileRead = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo" },
        }),
        { suspendOnWaiting: true },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const write = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo", contents: "new" },
        }),
      );
      expect(write._tag).toBe("Success");
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fileRead)).byteLength).toBe(5);
      h.registry.refresh(metadata);
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      expect(h.metadataRequests).toHaveLength(2);
    }),
  );

  it.effect("refreshes retained canonical and original paths after an aliased write", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("write-metadata-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const atoms = ["/repo/foo", "/repo/./foo"].map((path) =>
        h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path, threadId } }),
      );
      for (const atom of atoms) h.registry.mount(atom);
      const read = () =>
        Effect.forEach(
          atoms,
          (atom) => AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true }),
          { concurrency: "unbounded" },
        );
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "file", byteLength: 5 },
      ]);
      const result = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "./foo", contents: "new" },
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", value: { relativePath: "foo" } });
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 10 },
        { kind: "file", byteLength: 10 },
      ]);
      expect(h.metadataRequests.flat()).toEqual([
        "/repo/foo",
        "/repo/./foo",
        "/repo/foo",
        "/repo/./foo",
      ]);
    }),
  );
});

describe("openScratch", () => {
  it.effect("resolves once the created project reaches the client store", () =>
    Effect.gen(function* () {
      const { registry, storedProject, openScratch } = yield* makeHarness();
      const opening = yield* Effect.forkChild(openScratch);
      yield* Effect.yieldNow;
      registry.set(storedProject, PROJECT);
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({ _tag: "Success", value: PROJECT });
    }),
  );
});
