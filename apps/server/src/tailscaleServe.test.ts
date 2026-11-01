import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as TailscaleServe from "./tailscaleServe.ts";

const encoder = new TextEncoder();
const SERVE_PORT = 18443;
const OTHER_PORT = 18444;
const LOCAL_TARGET = "http://127.0.0.1:18638";

interface FakeOptions {
  /** `serve --bg` is refused this many times (operator not granted, Tailscale still starting). */
  readonly refusedServeAttempts?: number;
  /** The attempt after the refusals never answers. */
  readonly hangs?: boolean;
  /** The daemon applies the mapping at once but the CLI exits only after this delay. */
  readonly ackDelay?: Duration.Input;
  /** The Serve root starts out proxying to this other server. */
  readonly heldBy?: string;
  /** `serve status` fails this many times, as while the daemon is down. */
  readonly statusFailures?: number;
  /** `serve status` fails once right after the daemon takes the mapping. */
  readonly statusFailsAfterServe?: boolean;
  /** The Serve root on OTHER_PORT, as a run on that port left it. */
  readonly heldOnOtherPort?: string;
  /** The claim record a previous run left. */
  readonly recorded?: string;
  /** Writing the claim record fails, as on a read-only state dir. */
  readonly recordFails?: boolean;
  /** This machine's node ID on the live Tailscale account; null when signed out. */
  readonly account?: string | null;
  /** Every profile `tailscale switch --list` names, instead of just `profileId`. */
  readonly profileList?: ReadonlyArray<{ readonly id: string; readonly selected: boolean }>;
  readonly platform?: "linux" | "win32";
  /** The live account's tailnet and user, which name its login profile. */
  readonly profile?: { readonly tailnet: string; readonly userId: string };
  /** The login profile ID `tailscale switch --list` names. Without it, the CLI is too old. */
  readonly profileId?: string;
  /** Tailscale switches to this account, whose Serve config is empty, on the next Serve read. */
  readonly switchOnServeRead?: string;
}

// Stands in for the tailscale CLI and keeps the Serve root like the daemon does.
const makeFakeTailscale = (options: FakeOptions) => {
  const state = {
    serveAttempts: 0,
    statusCalls: 0,
    releases: 0,
    root: options.heldBy ?? null,
    otherRoot: options.heldOnOtherPort ?? null,
    statusFailurePending: false,
    account: options.account === undefined ? "n1" : options.account,
  };
  // Completes when the daemon takes the mapping, before the CLI exits.
  const mappingApplied = Deferred.makeUnsafe<void>();
  const serveStatus = () => {
    const roots = [
      [SERVE_PORT, state.root],
      [OTHER_PORT, state.otherRoot],
    ].filter(([, root]) => root !== null);
    return roots.length === 0
      ? "null\n"
      : JSON.stringify({
          TCP: Object.fromEntries(roots.map(([port]) => [port, { HTTPS: true }])),
          Web: Object.fromEntries(
            roots.map(([port, root]) => [
              `desktop.tail.ts.net:${port}`,
              { Handlers: { "/": { Proxy: root } } },
            ]),
          ),
        });
  };
  const handle = (
    args: ReadonlyArray<string>,
  ): { code: number; stdout?: string; stderr?: string; ackDelay?: Duration.Input } | undefined => {
    const command = args.join(" ");
    if (command === "switch --list --json" && options.profileList !== undefined) {
      return { code: 0, stdout: JSON.stringify(options.profileList) };
    }
    if (command === "switch --list --json") {
      return options.profileId === undefined
        ? { code: 1, stderr: "flag provided but not defined: -json" }
        : {
            code: 0,
            stdout: JSON.stringify([
              {
                id: options.profileId,
                tailnet: "example.com",
                account: "me@example.com",
                selected: true,
              },
            ]),
          };
    }
    if (command === "status --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { ID: state.account ?? undefined, UserID: options.profile?.userId },
          CurrentTailnet: { Name: options.profile?.tailnet },
        }),
      };
    }
    if (command === "serve status --json") {
      if (options.switchOnServeRead !== undefined && state.account !== options.switchOnServeRead) {
        state.account = options.switchOnServeRead;
        state.root = null;
      }
      state.statusCalls += 1;
      if (state.statusCalls <= (options.statusFailures ?? 0) || state.statusFailurePending) {
        state.statusFailurePending = false;
        return { code: 1, stderr: "failed to connect to local tailscaled" };
      }
      return { code: 0, stdout: serveStatus() };
    }
    if (args[0] === "serve" && args[1] === "--bg") {
      state.serveAttempts += 1;
      if (state.serveAttempts <= (options.refusedServeAttempts ?? 0)) {
        return { code: 1, stderr: "Access denied: serve config denied" };
      }
      if (options.hangs) {
        return undefined;
      }
      state.root = args.at(-1) ?? null;
      state.statusFailurePending = options.statusFailsAfterServe === true;
      Deferred.doneUnsafe(mappingApplied, Effect.void);
      return { code: 0, ...(options.ackDelay === undefined ? {} : { ackDelay: options.ackDelay }) };
    }
    if (command === `serve --https=${OTHER_PORT} --set-path=/ off`) {
      state.otherRoot = null;
      return { code: 0 };
    }
    if (command === `serve --https=${SERVE_PORT} --set-path=/ off`) {
      state.releases += 1;
      state.root = null;
      return { code: 0 };
    }
    return { code: 1, stderr: "unexpected command" };
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    const result = handle(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          result === undefined
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(result.code)).pipe(
                Effect.delay(result.ackDelay ?? 0),
              ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result?.stdout ?? "")),
        stderr: Stream.make(encoder.encode(result?.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { state, spawner, mappingApplied, platform: options.platform ?? "linux" };
};

const STATE_DIR = "/state";
const CLAIM_PATH = "/state/tailscale-serve-claim.json";
// A record made on login profile `id`, as a CLI that lists profiles writes it.
const profileRecord = (id: string) =>
  JSON.stringify({
    [id]: {
      localPort: 18638,
      localHost: "127.0.0.1",
      servePort: SERVE_PORT,
      label: "me@example.com on example.com",
      profileId: id,
    },
  });
// `keys` is set on records this server writes, and absent on ones a test seeds.
const record = (
  localPort: number,
  servePort: number,
  account = "n1",
  keys?: ReadonlyArray<string>,
) =>
  JSON.stringify({
    [account]: {
      localPort,
      localHost: "127.0.0.1",
      servePort,
      label: account,
      ...(keys === undefined ? {} : { keys }),
    },
  });

// In memory, so writes land within the test clock's steps.
const memoryFileSystem = (files: Map<string, string>, writeFails = false) => {
  const missing = FileSystem.makeNoop({});
  return FileSystem.makeNoop({
    readFileString: (path) => {
      const contents = files.get(path);
      return contents === undefined ? missing.readFileString(path) : Effect.succeed(contents);
    },
    writeFileString: (path, data) =>
      writeFails
        ? missing.writeFileString(path, data)
        : Effect.sync(() => void files.set(path, data)),
    makeDirectory: () => Effect.void,
    exists: (path) => Effect.succeed(files.has(path)),
    rename: (from, to) =>
      Effect.sync(() => {
        const contents = files.get(from);
        if (contents !== undefined) files.set(to, contents);
        files.delete(from);
      }),
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
};

const fakeLayers = (
  fake: ReturnType<typeof makeFakeTailscale>,
  files: Map<string, string>,
  writeFails = false,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    Layer.succeed(HostProcess.Platform, fake.platform),
    Layer.succeed(FileSystem.FileSystem, memoryFileSystem(files, writeFails)),
    Path.layer,
  );

const startTailscaleServe = Effect.fn(function* (options: FakeOptions = {}) {
  const fake = makeFakeTailscale(options);
  const files = new Map(options.recorded === undefined ? [] : [[CLAIM_PATH, options.recorded]]);
  const parked = yield* Deferred.make<void>();
  const settled = yield* Deferred.make<void>();
  const scope = yield* Scope.make();
  yield* Layer.buildWithScope(
    TailscaleServe.layer({
      stateDir: STATE_DIR,
      servePort: SERVE_PORT,
      parked,
      settled,
      awaitActivation: Effect.void,
    }).pipe(
      Layer.provide(
        Layer.merge(
          fakeLayers(fake, files, options.recordFails),
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 18638),
          }),
        ),
      ),
    ),
    scope,
  );
  return { state: fake.state, mappingApplied: fake.mappingApplied, scope, settled, files };
});

describe("TailscaleServe", () => {
  // regression: #16238 - a refused first `tailscale serve` left Serve off
  // until the server was restarted.
  it.effect("configures Serve once a later attempt succeeds, without a restart", () =>
    Effect.gen(function* () {
      const { state, settled } = yield* startTailscaleServe({ refusedServeAttempts: 1 });
      // Headless startup prints its pairing URL after the first attempt, not after every retry.
      yield* Deferred.await(settled);
      assert.equal(state.root, null);

      yield* TestClock.adjust("1 hour");

      assert.equal(state.root, LOCAL_TARGET, "Serve was never configured after the first refusal");
    }),
  );

  it.effect("keeps retrying with backoff capped at 30 seconds", () =>
    Effect.gen(function* () {
      // Attempts fall at 0, 1, 3, 7, 15 and 31 s, then every 30 s.
      const { state } = yield* startTailscaleServe({ refusedServeAttempts: 8 });
      let elapsedMs = 0;
      const attemptsAt = Effect.fn(function* (ms: number) {
        yield* TestClock.adjust(ms - elapsedMs);
        elapsedMs = ms;
        return state.serveAttempts;
      });

      assert.equal(yield* attemptsAt(999), 1, "retried before the first backoff delay");
      assert.equal(yield* attemptsAt(1_000), 2);
      assert.equal(yield* attemptsAt(30_999), 5);
      assert.equal(yield* attemptsAt(31_000), 6);
      assert.equal(yield* attemptsAt(60_999), 6, "backoff not capped at 30 seconds");
      assert.equal(yield* attemptsAt(61_000), 7);
      assert.equal(yield* attemptsAt(91_000), 8);
      assert.equal(state.root, null);
      assert.equal(yield* attemptsAt(121_000), 9);
      assert.equal(state.root, LOCAL_TARGET);
    }),
  );

  it.effect("removes its Serve root on shutdown after a later attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope, files } = yield* startTailscaleServe({ refusedServeAttempts: 1 });
      yield* TestClock.adjust("1 hour");
      assert.isTrue(files.has(CLAIM_PATH));

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.releases, 1);
      assert.equal(state.root, null);
      assert.isFalse(files.has(CLAIM_PATH));
    }),
  );

  it.effect("removes the mapping a run on another Serve port left, then claims its own", () =>
    Effect.gen(function* () {
      const { state, settled, files } = yield* startTailscaleServe({
        heldOnOtherPort: LOCAL_TARGET,
        recorded: record(18638, OTHER_PORT),
      });
      yield* Deferred.await(settled);

      assert.equal(state.otherRoot, null);
      assert.equal(state.root, LOCAL_TARGET);
      assert.include(files.get(CLAIM_PATH), `"servePort":${SERVE_PORT}`);
    }),
  );

  it.effect("keeps the record of an older local port until its mapping is removed", () =>
    Effect.gen(function* () {
      const older = record(18637, SERVE_PORT);
      const { scope, settled, files } = yield* startTailscaleServe({
        heldBy: "http://127.0.0.1:18637",
        recorded: older,
        statusFailures: 1,
      });
      yield* Deferred.await(settled);

      yield* Scope.close(scope, Exit.void);

      assert.equal(files.get(CLAIM_PATH), older);
    }),
  );

  it.effect("does not start Serve until its cleanup record is saved", () =>
    Effect.gen(function* () {
      const { state, settled } = yield* startTailscaleServe({ recordFails: true });
      yield* Deferred.await(settled);
      yield* TestClock.adjust("1 minute");

      assert.equal(state.serveAttempts, 0);
      assert.equal(state.root, null);
    }),
  );

  it.effect("with Serve off, removes a mapping a stopped run left, once Tailscale answers", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({ heldBy: LOCAL_TARGET, statusFailures: 2 });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT)]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 minute");

      assert.equal(fake.state.releases, 1);
      assert.equal(fake.state.root, null);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  // Each Tailscale account keeps its own Serve config, so the mapping is only visible there.
  it.effect("with Serve off, keeps another account's record until Tailscale switches to it", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({ heldBy: LOCAL_TARGET, account: "work" });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT, "personal")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 minute");
      assert.equal(fake.state.releases, 0);
      assert.isTrue(files.has(CLAIM_PATH));

      fake.state.account = "personal";
      yield* TestClock.adjust("10 minutes");

      assert.equal(fake.state.releases, 1);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("records the account a retry claims on, so shutdown removes that mapping", () =>
    Effect.gen(function* () {
      const { state, scope, settled, files } = yield* startTailscaleServe({
        refusedServeAttempts: 1,
      });
      yield* Deferred.await(settled);
      state.account = "work";
      yield* TestClock.adjust("1 second");
      assert.equal(state.root, LOCAL_TARGET);

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.releases, 1);
      // The refused try on the first account may have left nothing; its record waits there.
      assert.equal(files.get(CLAIM_PATH), record(18638, SERVE_PORT, "n1", ["n1"]));
    }),
  );

  it.effect("waits on an unreadable record instead of replacing it", () =>
    Effect.gen(function* () {
      const { state, settled, files } = yield* startTailscaleServe({ recorded: "{" });
      yield* Deferred.await(settled);
      yield* TestClock.adjust("1 minute");

      assert.equal(state.serveAttempts, 0);
      assert.equal(files.get(CLAIM_PATH), "{");
    }),
  );

  it.effect("matches a record to its account after the device is re-added with a new node ID", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({
        heldBy: LOCAL_TARGET,
        account: "nReAdded",
        profile: { tailnet: "example.com", userId: "7" },
      });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT, "example.com/7")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 1);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("matches a record to its login profile after the host is tagged", () =>
    Effect.gen(function* () {
      // Tagging changes the host's user, and with it the tailnet-and-user key.
      const fake = makeFakeTailscale({
        heldBy: LOCAL_TARGET,
        profileId: "prof1",
        profile: { tailnet: "example.com", userId: "tagged-devices" },
      });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT, "prof1")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 1);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("matches a record an older Tailscale CLI keyed by tailnet and user", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({
        heldBy: LOCAL_TARGET,
        profileId: "prof1",
        profile: { tailnet: "example.com", userId: "7" },
      });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT, "example.com/7")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 1);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("drops the record of a login profile that `tailscale logout` deleted", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({ profileId: "prof2" });
      const files = new Map([[CLAIM_PATH, profileRecord("prof1")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("matches a record by any key it was written with when a profile read fails", () =>
    Effect.gen(function* () {
      // `switch --list` fails this time, so only the tailnet and user name the account.
      const fake = makeFakeTailscale({
        heldBy: LOCAL_TARGET,
        profile: { tailnet: "example.com", userId: "7" },
      });
      const files = new Map([
        [
          CLAIM_PATH,
          JSON.stringify({
            prof1: {
              localPort: 18638,
              localHost: "127.0.0.1",
              servePort: SERVE_PORT,
              label: "me@example.com on example.com",
              profileId: "prof1",
              keys: ["prof1", "example.com/7", "n1"],
            },
          }),
        ],
      ]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 1);
      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("on Windows, keeps the record of a profile Tailscale does not list", () =>
    Effect.gen(function* () {
      // Windows lists only the signed-in Windows user's profiles, so the profile may exist.
      const fake = makeFakeTailscale({ profileId: "prof2", platform: "win32" });
      const files = new Map([[CLAIM_PATH, profileRecord("prof1")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(files.get(CLAIM_PATH), profileRecord("prof1"));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("a record from another profile on the same tailnet and user is not this one's", () =>
    Effect.gen(function* () {
      // Two Windows users signed in to one Tailscale account each have their own profile.
      const fake = makeFakeTailscale({
        heldBy: LOCAL_TARGET,
        profileId: "profB",
        profile: { tailnet: "example.com", userId: "7" },
        platform: "win32",
      });
      const recorded = JSON.stringify({
        profA: {
          localPort: 18638,
          localHost: "127.0.0.1",
          servePort: SERVE_PORT,
          label: "me@example.com on example.com",
          profileId: "profA",
          keys: ["profA", "example.com/7", "nA"],
        },
      });
      const files = new Map([[CLAIM_PATH, recorded]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 0);
      assert.equal(files.get(CLAIM_PATH), recorded);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("signed out of the last profile, drops its record", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({ account: null, profileList: [] });
      const files = new Map([[CLAIM_PATH, profileRecord("prof1")]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.isFalse(files.has(CLAIM_PATH));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "keeps an older port's record when Tailscale switches accounts during its removal",
    () =>
      Effect.gen(function* () {
        const older = record(18638, OTHER_PORT);
        const { settled, files } = yield* startTailscaleServe({
          heldOnOtherPort: LOCAL_TARGET,
          recorded: older,
          switchOnServeRead: "work",
        });
        yield* Deferred.await(settled);

        assert.equal(files.get(CLAIM_PATH), older);
      }),
  );

  it.effect("keeps the record when Tailscale switches accounts during its removal", () =>
    Effect.gen(function* () {
      const fake = makeFakeTailscale({ heldBy: LOCAL_TARGET, switchOnServeRead: "work" });
      const files = new Map([[CLAIM_PATH, record(18638, SERVE_PORT)]]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        TailscaleServe.layerReleaseLeftover({ stateDir: STATE_DIR }).pipe(
          Layer.provide(fakeLayers(fake, files)),
        ),
        scope,
      );
      yield* TestClock.adjust("1 second");

      assert.equal(fake.state.releases, 0);
      assert.equal(files.get(CLAIM_PATH), record(18638, SERVE_PORT));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps its record on shutdown after Tailscale switched to another account", () =>
    Effect.gen(function* () {
      const { state, scope, settled, files } = yield* startTailscaleServe();
      yield* Deferred.await(settled);
      state.account = "work";

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.releases, 0);
      assert.equal(files.get(CLAIM_PATH), record(18638, SERVE_PORT, "n1", ["n1"]));
    }),
  );

  it.effect("removes the Serve root on shutdown while the CLI has yet to acknowledge it", () =>
    Effect.gen(function* () {
      const { state, mappingApplied, scope } = yield* startTailscaleServe({
        ackDelay: "2 seconds",
      });
      yield* Deferred.await(mappingApplied);
      assert.equal(state.serveAttempts, 1);

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(shutdown);

      assert.equal(state.releases, 1, "a mapping the daemon applied outlived shutdown");
    }),
  );

  it.effect("removes the Serve root on shutdown when the claim landed but its check failed", () =>
    Effect.gen(function* () {
      const { state, scope, settled } = yield* startTailscaleServe({ statusFailsAfterServe: true });
      yield* Deferred.await(settled);
      assert.equal(state.root, LOCAL_TARGET);

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.releases, 1, "a mapping the daemon applied outlived shutdown");
    }),
  );

  it.effect("stops retrying on shutdown and leaves Serve alone if no attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe({
        refusedServeAttempts: Number.POSITIVE_INFINITY,
      });
      yield* TestClock.adjust("1 minute");
      const attemptsBeforeShutdown = state.serveAttempts;

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 hour");

      assert.isAbove(attemptsBeforeShutdown, 1);
      assert.equal(state.serveAttempts, attemptsBeforeShutdown);
      assert.equal(state.releases, 0);
    }),
  );

  it.effect("waits on shutdown no longer than the Serve command's timeout", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe({ refusedServeAttempts: 1, hangs: true });
      yield* TestClock.adjust("1 second");
      assert.equal(state.serveAttempts, 2);

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(shutdown);

      // No attempt succeeded, so the port is not ours to clear.
      assert.equal(state.releases, 0);
    }),
  );

  // regression: #10363 - a second server took the Serve URL from the running one.
  it.effect("leaves another server's Serve root alone and takes over once it is gone", () =>
    Effect.gen(function* () {
      const otherServer = "http://192.168.1.20:3773";
      const { state, scope } = yield* startTailscaleServe({ heldBy: otherServer });
      yield* TestClock.adjust("1 minute");
      assert.equal(state.serveAttempts, 0);
      assert.equal(state.root, otherServer);

      state.root = null;
      yield* TestClock.adjust("30 seconds");
      assert.equal(state.root, LOCAL_TARGET);

      // Another server took the port back, so shutdown must not remove its root.
      state.root = otherServer;
      yield* Scope.close(scope, Exit.void);
      assert.equal(state.releases, 0);
      assert.equal(state.root, otherServer);
    }),
  );
});
