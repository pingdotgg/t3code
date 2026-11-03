import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  type AssetResource,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  ASSET_URL_MAX_IN_FLIGHT,
  makeRevisionedAssetUrlFamily,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "./assets.ts";

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

/**
 * Environments whose `assets.createUrl` never answers until the test releases a call.
 * `started` receives the environment of each call as it begins, and `inFlight` counts
 * calls that have begun and not yet been released or interrupted.
 */
const makeAssetUrlHarness = Effect.fn("TestAssetUrl.makeHarness")(function* (
  environmentIds: ReadonlyArray<EnvironmentId>,
) {
  const started = yield* Queue.unbounded<EnvironmentId>();
  const inFlight = new Map<EnvironmentId, number>();
  const maxInFlight = new Map<EnvironmentId, number>();
  const releases = new Map<EnvironmentId, Queue.Queue<void>>();
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const sessions = new Map<
    EnvironmentId,
    SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>
  >();
  const makeSession = (environmentId: EnvironmentId) =>
    ({
      client: {
        [WS_METHODS.assetsCreateUrl]: () =>
          Effect.gen(function* () {
            const now = (inFlight.get(environmentId) ?? 0) + 1;
            inFlight.set(environmentId, now);
            maxInFlight.set(environmentId, Math.max(maxInFlight.get(environmentId) ?? 0, now));
            yield* Queue.offer(started, environmentId);
            yield* Queue.take(releases.get(environmentId)!);
            return { relativeUrl: "/api/assets/token/image.png", expiresAt: 4_000_000_000_000 };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() =>
                inFlight.set(environmentId, (inFlight.get(environmentId) ?? 1) - 1),
              ),
            ),
          ),
      },
    }) as unknown as RpcSession.RpcSession;
  for (const environmentId of environmentIds) {
    releases.set(environmentId, yield* Queue.unbounded<void>());
    const session = yield* SubscriptionRef.make(Option.some(makeSession(environmentId)));
    sessions.set(environmentId, session);
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://assets.example.test",
          wsBaseUrl: "wss://assets.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
    );
  }
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!,
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!,
    );
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createAssetEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
  );
  return {
    started,
    inFlight: (environmentId: EnvironmentId) => inFlight.get(environmentId) ?? 0,
    maxInFlight: (environmentId: EnvironmentId) => maxInFlight.get(environmentId) ?? 0,
    release: (environmentId: EnvironmentId) => Queue.offer(releases.get(environmentId)!, undefined),
    replaceSession: (environmentId: EnvironmentId) =>
      SubscriptionRef.set(sessions.get(environmentId)!, Option.some(makeSession(environmentId))),
    mountImages: (environmentId: EnvironmentId, count: number) => {
      for (let index = 0; index < count; index += 1) {
        registry.mount(
          atoms.createUrl({
            environmentId,
            input: { resource: { _tag: "attachment", attachmentId: `image-${index}` } },
          }),
        );
      }
    },
  };
});

describe("asset URL requests", () => {
  const remote = EnvironmentId.make("asset-remote");
  const other = EnvironmentId.make("asset-other");

  it.effect("keeps a thread of images from flooding one environment with requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote]);
        const total = ASSET_URL_MAX_IN_FLIGHT * 3;
        harness.mountImages(remote, total);

        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        expect(harness.inFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);

        // Each answer admits the next waiting request.
        for (let call = 0; call < total; call += 1) {
          yield* harness.release(remote);
          if (call < total - ASSET_URL_MAX_IN_FLIGHT) yield* Queue.take(harness.started);
        }
        expect(harness.maxInFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );

  it.effect("limits each environment on its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote, other]);
        harness.mountImages(remote, ASSET_URL_MAX_IN_FLIGHT + 2);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        harness.mountImages(other, 1);
        expect(yield* Queue.take(harness.started)).toBe(other);
        expect(harness.inFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );

  it.effect("frees the limit when the session behind the requests is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote]);
        harness.mountImages(remote, ASSET_URL_MAX_IN_FLIGHT * 2);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }

        yield* harness.replaceSession(remote);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        expect(harness.maxInFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );
});

const environmentId = EnvironmentId.make("environment-1");
const resource: AssetResource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread-1"),
  path: "docs/diagram.png",
};

type MintResult = AsyncResult.AsyncResult<{
  relativeUrl: string;
  expiresAt: number;
  fileRevision?: string;
}>;

const minted = (n: number, fileRevision?: string): MintResult =>
  AsyncResult.success({
    relativeUrl: `/a/${n}`,
    expiresAt: 60 * 60_000,
    ...(fileRevision === undefined ? {} : { fileRevision }),
  });

// A stand-in for the asset URL query: a refresh starts a mint (counted, shown as
// waiting) and `settle` completes the latest one.
function setup(initial: MintResult) {
  let mints = 0;
  // Node removal runs on the registry's scheduler; `unmount` flushes it so the
  // next mount of the same revision builds a fresh node.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      mints += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedAssetUrlFamily(
    () => query,
    () => 0,
  );
  const mount = (revision: string | null) => {
    const release = registry.mount(revisioned({ environmentId, input: { resource }, revision }));
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const flush = () => {
    for (const task of scheduled.splice(0)) task();
  };
  const settle = (fileRevision?: string) => registry.set(server, minted(mints + 1, fileRevision));
  const url = (revision: string | null) => {
    const result = registry.get(revisioned({ environmentId, input: { resource }, revision }));
    return result._tag === "Success" ? result.value.relativeUrl : null;
  };
  return { mount, settle, flush, url, reset: () => registry.reset(), mints: () => mints };
}

describe("makeRevisionedAssetUrlFamily", () => {
  it("defers a shared URL refresh until after reads and discards a disposed read", () => {
    const { mount, flush, reset, mints } = setup(minted(0));

    mount("mutation-1");
    expect(mints()).toBe(0);
    reset();
    flush();
    expect(mints()).toBe(0);

    const release = mount("mutation-1");
    const releaseDuplicate = mount("mutation-1");
    expect(mints()).toBe(0);
    flush();
    expect(mints()).toBe(1);
    release();
    releaseDuplicate();
  });

  it("re-mints a settled URL on first read and on each new revision, not on remount", () => {
    const { mount, settle, flush, mints } = setup(minted(0));

    const releaseFirst = mount("mutation-1");
    flush();
    releaseFirst();
    expect(mints()).toBe(1);
    settle();

    mount("mutation-1")();
    expect(mints()).toBe(1);

    const releaseSecond = mount("mutation-2");
    flush();
    releaseSecond();
    expect(mints()).toBe(2);
  });

  it("re-mints when a revert returns to an earlier revision", () => {
    const { mount, settle, flush, mints } = setup(minted(0));

    const releaseA = mount("mutation-a");
    flush();
    releaseA();
    settle();
    const releaseB = mount("mutation-b");
    flush();
    releaseB();
    settle();
    expect(mints()).toBe(2);

    const reverted = mount("mutation-a");
    flush();
    expect(mints()).toBe(3);
    reverted();
  });

  it("shares a mint in flight on the first read", () => {
    const { mount, mints } = setup(AsyncResult.initial(true));

    mount("mutation-1")();
    expect(mints()).toBe(0);
  });

  it("re-mints after a mint that was in flight when the revision changed", () => {
    const { mount, settle, flush, mints } = setup(minted(0));

    const before = mount("mutation-1");
    flush();
    settle();
    const edited = mount("mutation-2");
    flush();
    expect(mints()).toBe(2);
    before();

    const stillMinting = mount("mutation-3");
    edited();
    expect(mints()).toBe(2);

    settle();
    flush();
    expect(mints()).toBe(3);
    settle();
    flush();
    expect(mints()).toBe(3);
    stillMinting();
  });
  it("keeps the URL while the file is unchanged and swaps it once the file changes", () => {
    const { mount, settle, flush, url } = setup(minted(0, "file-a"));

    const first = mount("mutation-1");
    flush();
    settle("file-a");
    first();

    const unchanged = mount("mutation-2");
    flush();
    settle("file-a");
    expect(url("mutation-2")).toBe("/a/0");
    unchanged();

    // The query now holds /a/3; a later revision must still keep the URL on screen.
    const stillUnchanged = mount("mutation-3");
    flush();
    expect(url("mutation-3")).toBe("/a/0");
    settle("file-a");
    expect(url("mutation-3")).toBe("/a/0");
    stillUnchanged();

    const edited = mount("mutation-4");
    flush();
    settle("file-b");
    expect(url("mutation-4")).toBe("/a/5");
    edited();
  });
});
