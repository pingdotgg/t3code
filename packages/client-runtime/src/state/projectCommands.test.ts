import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

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
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.projectsEnsureScratch]: () => Effect.succeed({ projectId: PROJECT_ID }),
          [WS_METHODS.projectsWriteFile]: () =>
            Effect.sync(() => {
              file.byteLength = 10;
              return { relativePath: "foo" };
            }),
          [WS_METHODS.filesystemGetMetadata]: (input: { paths: string[] }) =>
            Effect.sync(() => {
              metadataRequests.push(input.paths);
              return {
                entries: input.paths.map(() => ({
                  kind: "file" as const,
                  byteLength: file.byteLength,
                })),
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
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
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
  return { registry, storedProject, openScratch, commands, metadataRequests };
});

describe("writeFile metadata", () => {
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
    }).pipe(Effect.scoped),
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
    }).pipe(Effect.scoped),
  );
});
