import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Option from "effect/Option";
import * as Os from "node:os";
import HandoffWorkerLive, {
  HandoffWorker,
  setDeployN,
} from "./fixtures/handoff-worker.ts";

/**
 * `dev: true` runs the local providers in a persistent, file-scoped RPC
 * sidecar by default, exactly like `alchemy dev` (see MakeOptions.sidecar in
 * Test/Core.ts). This test DEPENDS on that topology: in-process (`sidecar:
 * false`), each `deploy(Stack)` builds a fresh provider (fresh in-memory
 * instance maps), so the second deploy never takes the "Changes detected,
 * interrupting existing instance" replacement path this test exists to
 * cover. The proxy caches its sidecar session per entry URL, so both
 * deploys talk to the same provider process.
 */
const { test, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "LocalWorkerHandoffStack",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* HandoffWorker;
    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName.as<string>(),
    };
  }).pipe(Effect.provide(HandoffWorkerLive)),
);

const fetchDeploy = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    if (res.status !== 200) {
      const text = yield* res.text;
      return yield* Effect.fail(
        new Error(`status ${res.status}: ${text.slice(0, 500)}`),
      );
    }
    const body = (yield* res.json) as { deploy: string; pong: string };
    expect(body.pong).toBe("pong");
    return body.deploy;
  }).pipe(Effect.timeout("10 seconds"));

const registryEntryPath = (workerName: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const stateHome =
      process.env.XDG_STATE_HOME ?? path.join(Os.homedir(), ".local", "state");
    return path.join(
      stateHome,
      "alchemy",
      "registry",
      `${encodeURIComponent(workerName)}.json`,
    );
  });

const registryEntryExists = (workerName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(yield* registryEntryPath(workerName));
  });

/**
 * The registry entry's inode. A make-before-break handoff only ever
 * overwrites `{scriptName}.json` in place (the replacement re-registers,
 * then the owner-aware unregister of the old instance no-ops), so the inode
 * is stable across a redeploy. The broken path unlinks the entry when the
 * old instance is torn down and recreates it when the replacement finally
 * serves — observable as an inode change even when the dark window itself
 * is too short to catch with a request.
 */
const registryEntryIno = (workerName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(yield* registryEntryPath(workerName));
    return Option.getOrUndefined(stat.ino);
  });

/**
 * Regression test for alchemy-run/alchemy#859: replacing a local dev Worker
 * instance (a reconcile with a changed structural signature logs "Changes
 * detected, interrupting existing instance") must not tear down the running
 * workerd before the replacement has started. The last good instance keeps
 * serving — and keeps its dev-registry entry, which cross-script DO bindings
 * resolve through — until the replacement's first serve completes.
 */
test(
  "previous instance keeps serving and stays registered during redeploy",
  Effect.gen(function* () {
    // Clear any state a previous interrupted run left behind.
    yield* destroy(Stack);

    setDeployN("1");
    const first = yield* deploy(Stack);

    // The local provider serves from the dev proxy — proof no cloud call ran.
    expect(first.url).toMatch(/^http:\/\/localhost:\d+$/);

    // Wait for the first instance to actually serve (fresh workerd + DO).
    const initial = yield* fetchDeploy(first.url).pipe(
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 20,
      }),
    );
    expect(initial).toBe("1");
    expect(yield* registryEntryExists(first.workerName)).toBe(true);
    const inoBefore = yield* registryEntryIno(first.workerName);

    // Redeploy with a changed env var: the Worker's structural signature
    // changes, so the provider replaces the instance. The deploy returns as
    // soon as reconcile completes — before the replacement workerd has
    // started serving.
    setDeployN("2");
    const second = yield* deploy(Stack);

    // The previous instance must still be serving (make-before-break): a
    // single un-retried request must succeed, whether it is answered by the
    // old instance ("1") or an already-cut-over replacement ("2").
    const during = yield* fetchDeploy(second.url);
    expect(["1", "2"]).toContain(during);

    // ...and its dev-registry entry must still exist, so cross-script DO
    // bindings from other workers keep resolving throughout the handoff.
    expect(yield* registryEntryExists(second.workerName)).toBe(true);

    // The replacement eventually takes over.
    const final = yield* fetchDeploy(second.url).pipe(
      Effect.flatMap((deploy) =>
        deploy === "2"
          ? Effect.succeed(deploy)
          : Effect.fail(new Error(`still serving deploy ${deploy}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 90 }),
    );
    expect(final).toBe("2");
    expect(yield* registryEntryExists(second.workerName)).toBe(true);
    // The entry was overwritten in place by the replacement, never deleted —
    // cross-script DO bindings resolving through it never saw it vanish.
    expect(yield* registryEntryIno(second.workerName)).toBe(inoBefore);

    yield* destroy(Stack);
  }).pipe(logLevel),
  { timeout: 240_000 },
);
