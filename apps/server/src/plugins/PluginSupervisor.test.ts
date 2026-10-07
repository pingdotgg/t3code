import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PluginHostState, PluginId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

const FIXTURE_DIR = `${import.meta.dirname}/testFixtures/plugin`;
// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;

const testOptions = {
  heapLimitMb: 64,
  maxMessageBytes: 64 * 1024,
  activationTimeout: "5 seconds",
  callTimeout: "5 seconds",
  cancelGrace: "1 second",
  stopGrace: "1 second",
  maxRestarts: 2,
  restartBackoff: "1 second",
  maxRestartBackoff: "4 seconds",
  stableUptime: "1 minute",
} satisfies Partial<PluginSupervisor.PluginSupervisorOptions>;

const makeSupervisor = (overrides: Partial<PluginSupervisor.PluginSupervisorOptions> = {}) =>
  PluginSupervisor.make({ ...testOptions, ...overrides }).pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
  );

/** Copies the fixture plugin into a scoped temp directory under its own manifest. */
const preparePlugin = Effect.fn("preparePlugin")(function* (
  id: string,
  manifest: Record<string, unknown> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-" });
  for (const file of yield* fs.readDirectory(FIXTURE_DIR))
    if (file.endsWith(".mjs"))
      yield* fs.copyFile(path.join(FIXTURE_DIR, file), path.join(directory, file));
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson({
      id,
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entry: "main.mjs",
      proposedApi: true,
      ...manifest,
    }),
  );
  return { directory, registration: yield* loadPluginDirectory(directory) };
});

type Supervisor = PluginSupervisor.PluginSupervisor["Service"];
type Subscription = PubSub.Subscription<PluginSupervisor.PluginSupervisorEvent>;

const awaitState = Effect.fn("awaitState")(function* <Tag extends PluginHostState["_tag"]>(
  supervisor: Supervisor,
  subscription: Subscription,
  pluginId: PluginId,
  tag: Tag,
) {
  let current = yield* supervisor.state(pluginId);
  while (true) {
    if (Option.isSome(current) && current.value._tag === tag)
      return current.value as Extract<PluginHostState, { _tag: Tag }>;
    const event = yield* PubSub.take(subscription);
    if (event._tag === "StateChanged" && event.pluginId === pluginId)
      current = Option.some(event.state);
  }
});

const awaitLog = Effect.fn("awaitLog")(function* (
  subscription: Subscription,
  pluginId: PluginId,
  message: string,
) {
  while (true) {
    const event = yield* PubSub.take(subscription);
    if (event._tag === "Log" && event.pluginId === pluginId && event.message === message) return;
  }
});

const awaitLogMatching = Effect.fn("awaitLogMatching")(function* (
  subscription: Subscription,
  pluginId: PluginId,
  pattern: RegExp,
) {
  while (true) {
    const event = yield* PubSub.take(subscription);
    if (event._tag === "Log" && event.pluginId === pluginId && pattern.test(event.message))
      return event.message;
  }
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const pidOf = (value: unknown) => (value as { readonly pid: number }).pid;

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.layer(NodeServices.layer)("PluginSupervisor", (it) => {
  describe("manifests", () => {
    it.effect("loads the fixture and refuses incompatible or escaping plugins", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* loadPluginDirectory(FIXTURE_DIR);
        expect(fixture.manifest).toMatchObject({
          id: "test.fixture",
          apiVersion: 1,
          capabilities: [],
          proposedApi: true,
        });
        expect(fixture.entryPath.endsWith(`${path.sep}main.mjs`)).toBe(true);

        const reason = (manifest: Record<string, unknown>) =>
          preparePlugin("test.invalid", manifest).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        expect(yield* reason({ apiVersion: 2 })).toContain("targets plugin API version 2");
        expect(yield* reason({ capabilities: ["tools"] })).toContain("does not support tools");
        expect(yield* reason({ entry: "../main.mjs" })).toContain("is invalid");
        expect(yield* reason({ entry: "main.ts" })).toContain("is invalid");
        expect(yield* reason({ id: "Not-Qualified" })).toContain("is invalid");

        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-outside-" });
        yield* fs.writeFileString(
          path.join(outside, "escape.mjs"),
          "export function activate() {}",
        );
        const { directory } = yield* preparePlugin("test.symlink");
        yield* fs.symlink(path.join(outside, "escape.mjs"), path.join(directory, "link.mjs"));
        yield* fs.writeFileString(
          path.join(directory, "t3-plugin.json"),
          toJson({
            id: "test.symlink",
            name: "Symlink",
            version: "1",
            apiVersion: 1,
            entry: "link.mjs",
          }),
        );
        const escaped = yield* loadPluginDirectory(directory).pipe(Effect.flip);
        expect(escaped.message).toContain("resolves outside the plugin directory");
      }),
    );
  });

  describe("lifecycle", () => {
    it.effect("starts no process until first use and stops it on disable and shutdown", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const supervisor = yield* makeSupervisor();
        const { directory, registration } = yield* preparePlugin("test.lazy");
        const pluginId = registration.manifest.id;
        const marker = path.join(directory, "activated.marker");

        yield* supervisor.enable(registration);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.some({ _tag: "idle" }));
        expect(yield* fs.exists(marker)).toBe(false);
        const duplicate = yield* supervisor.enable(registration).pipe(Effect.flip);
        expect(duplicate._tag).toBe("PluginAlreadyEnabledError");

        const result = yield* supervisor.invoke(pluginId, "ping", { hello: "world" });
        expect(result).toMatchObject({ input: { hello: "world" } });
        const pid = pidOf(result);
        expect(yield* fs.exists(marker)).toBe(true);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.some({ _tag: "running" }));
        expect(isProcessAlive(pid)).toBe(true);

        yield* supervisor.disable(pluginId);
        expect(isProcessAlive(pid)).toBe(false);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.none());
        const afterDisable = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
        expect(afterDisable._tag).toBe("PluginNotEnabledError");

        // Closing the supervisor's scope stops every plugin it still runs.
        const shutdownPid = yield* Effect.scoped(
          Effect.gen(function* () {
            const scoped = yield* makeSupervisor();
            yield* scoped.enable(registration);
            return pidOf(yield* scoped.invoke(pluginId, "ping", null));
          }),
        );
        expect(isProcessAlive(shutdownPid)).toBe(false);
      }),
    );

    it.effect("kills a plugin stuck in a synchronous loop while other plugins keep answering", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const spinner = (yield* preparePlugin("test.spinner")).registration;
        const bystander = (yield* preparePlugin("test.bystander")).registration;
        yield* supervisor.enable(spinner);
        yield* supervisor.enable(bystander);
        const spinnerPid = pidOf(yield* supervisor.invoke(spinner.manifest.id, "ping", null));
        const bystanderPid = pidOf(yield* supervisor.invoke(bystander.manifest.id, "ping", null));

        const spinning = yield* supervisor
          .invoke(spinner.manifest.id, "spin", null, { timeout: "2 seconds" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        // The server's event loop is free while the spinner's is blocked.
        const answer = yield* supervisor.invoke(bystander.manifest.id, "ping", "still here");
        expect(answer).toEqual({ pid: bystanderPid, input: "still here" });

        yield* TestClock.adjust("2 seconds");
        const timedOut = yield* Fiber.join(spinning);
        expect(timedOut._tag).toBe("PluginTimeoutError");
        expect(isProcessAlive(spinnerPid)).toBe(true);

        yield* TestClock.adjust("1 second");
        const backoff = yield* awaitState(supervisor, subscription, spinner.manifest.id, "backoff");
        expect(backoff.reason).toContain('did not stop "spin" within 1000ms of cancellation');
        expect(isProcessAlive(spinnerPid)).toBe(false);
        expect(yield* supervisor.invoke(bystander.manifest.id, "ping", null)).toMatchObject({
          pid: bystanderPid,
        });
      }),
    );

    it.effect("lets a handler that honours cancellation settle without a kill", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const { registration } = yield* preparePlugin("test.cooperative");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const pid = pidOf(yield* supervisor.invoke(pluginId, "ping", null));

        const call = yield* supervisor
          .invoke(pluginId, "cooperative", null, { timeout: "1 second" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(call))._tag).toBe("PluginTimeoutError");
        // The child answers the cancel before it answers this later call.
        expect(pidOf(yield* supervisor.invoke(pluginId, "ping", null))).toBe(pid);

        yield* TestClock.adjust("1 second");
        expect(pidOf(yield* supervisor.invoke(pluginId, "ping", null))).toBe(pid);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.some({ _tag: "running" }));
      }),
    );

    it.effect("fails in-flight calls on disable and drops the plugin's late answer", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const { registration } = yield* preparePlugin("test.late");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const pid = pidOf(yield* supervisor.invoke(pluginId, "ping", null));

        const call = yield* supervisor
          .invoke(pluginId, "late", null)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* awaitLog(subscription, pluginId, "late-started");
        // Deactivation aborts the handler, which then answers "late value".
        yield* supervisor.disable(pluginId);

        const exit = yield* Fiber.join(call);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Option.getOrUndefined(Exit.findErrorOption(exit))?._tag).toBe("PluginStoppedError");
        expect(isProcessAlive(pid)).toBe(false);
      }),
    );
  });

  describe("concurrency", () => {
    it.effect("counts cancelled calls against the cap until the plugin answers them", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor({ maxConcurrentCalls: 1 });
        const subscription = yield* supervisor.subscribe;
        const stalled = (yield* preparePlugin("test.stalled")).registration;
        const polite = (yield* preparePlugin("test.polite")).registration;
        yield* supervisor.enable(stalled);
        yield* supervisor.enable(polite);
        const stalledPid = pidOf(yield* supervisor.invoke(stalled.manifest.id, "ping", null));

        const stalling = yield* supervisor
          .invoke(stalled.manifest.id, "stall", null, { timeout: "1 second" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(stalling))._tag).toBe("PluginTimeoutError");
        // Retries after the timeout are refused while the plugin still holds the call.
        const retries = yield* Effect.forEach(Array.from({ length: 4 }), () =>
          supervisor.invoke(stalled.manifest.id, "ping", null).pipe(Effect.flip),
        );
        expect(retries.map((error) => error._tag)).toEqual(Array(4).fill("PluginBusyError"));
        // The slot comes back only when the unanswered process is killed.
        yield* TestClock.adjust("1 second");
        yield* awaitState(supervisor, subscription, stalled.manifest.id, "backoff");
        expect(isProcessAlive(stalledPid)).toBe(false);

        // A plugin that answers the cancel frees its slot without a kill.
        const politePid = pidOf(yield* supervisor.invoke(polite.manifest.id, "ping", null));
        const cooperative = yield* supervisor
          .invoke(polite.manifest.id, "cooperative", null, { timeout: "1 second" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(cooperative))._tag).toBe("PluginTimeoutError");
        yield* awaitLog(subscription, polite.manifest.id, "cooperative-settled");
        expect(pidOf(yield* supervisor.invoke(polite.manifest.id, "ping", null))).toBe(politePid);
      }),
    );
  });

  describe("disable", () => {
    it.effect("keeps stopping a plugin after the disabling caller is interrupted", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const supervisor = yield* makeSupervisor().pipe(Scope.provide(scope));
        const subscription = yield* supervisor.subscribe;
        const { registration } = yield* preparePlugin("test.interrupted");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const pid = pidOf(yield* supervisor.invoke(pluginId, "ping", null));
        yield* supervisor.invoke(pluginId, "holdDeactivate", null);

        const disabling = yield* supervisor
          .disable(pluginId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* awaitLog(subscription, pluginId, "deactivate-held");
        yield* Fiber.interrupt(disabling);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.none());
        expect(isProcessAlive(pid)).toBe(true);

        // Shutdown still owns the stopping process and kills it after the grace.
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(closing);
        expect(isProcessAlive(pid)).toBe(false);
      }),
    );

    it.effect("makes a repeated disable wait for the interrupted stop to finish", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const { registration } = yield* preparePlugin("test.retried");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const pid = pidOf(yield* supervisor.invoke(pluginId, "ping", null));
        yield* supervisor.invoke(pluginId, "holdDeactivate", null);

        const disabling = yield* supervisor
          .disable(pluginId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* awaitLog(subscription, pluginId, "deactivate-held");
        yield* Fiber.interrupt(disabling);

        const retry = yield* supervisor
          .disable(pluginId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(retry.pollUnsafe()).toBeUndefined();
        expect(isProcessAlive(pid)).toBe(true);
        expect(yield* supervisor.state(pluginId)).toEqual(Option.none());

        yield* TestClock.adjust("1 second");
        yield* Fiber.join(retry);
        expect(isProcessAlive(pid)).toBe(false);
      }),
    );

    it.effect("fails a call waiting for activation once disable begins", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const { registration } = yield* preparePlugin("test.racing", {
          entry: "deferredActivate.mjs",
        });
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);

        const waiting = yield* supervisor
          .invoke(pluginId, "ping", null)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* awaitLog(subscription, pluginId, "activating");
        // Deactivation lets activation finish, and the process keeps serving.
        const disabling = yield* supervisor
          .disable(pluginId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect((yield* Fiber.join(waiting))._tag).toBe("PluginStoppedError");

        // A re-enabled plugin with the same id waits for the old process to go.
        const replacement = (yield* preparePlugin("test.racing")).registration;
        yield* supervisor.enable(replacement);
        const early = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
        expect(early.message).toContain("its previous process is still stopping");

        yield* TestClock.adjust("1 second");
        yield* Fiber.join(disabling);
        expect(yield* supervisor.invoke(pluginId, "ping", "fresh")).toMatchObject({
          input: "fresh",
        });
      }),
    );
  });

  describe("faults", () => {
    it.effect("reports a plugin that exhausts its heap", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const { registration } = yield* preparePlugin("test.oom");
        yield* supervisor.enable(registration);

        const error = yield* supervisor
          .invoke(registration.manifest.id, "oom", null)
          .pipe(Effect.flip);
        expect(error._tag).toBe("PluginCrashedError");
        expect(error.message).toContain("ran out of memory (heap limit 64 MB)");
        const state = yield* supervisor.state(registration.manifest.id);
        expect(Option.getOrUndefined(state)?._tag).toBe("backoff");
      }),
    );

    it.effect("kills a plugin that sends malformed or oversized IPC", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const malformed = (yield* preparePlugin("test.malformed")).registration;
        const oversized = (yield* preparePlugin("test.oversized")).registration;
        yield* supervisor.enable(malformed);
        yield* supervisor.enable(oversized);

        const garbage = yield* supervisor
          .invoke(malformed.manifest.id, "malformed", null)
          .pipe(Effect.flip);
        expect(garbage.message).toContain("sent a malformed IPC message");

        const flood = yield* supervisor
          .invoke(oversized.manifest.id, "oversizedFrame", { bytes: 70_000 })
          .pipe(Effect.flip);
        expect(flood.message).toContain("sent an IPC message larger than 65536 bytes");
      }),
    );

    it.effect("stops reading a plugin that floods logs and still delivers its result", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const flood = (yield* preparePlugin("test.flood")).registration;
        const calm = (yield* preparePlugin("test.calm")).registration;
        yield* supervisor.enable(flood);
        yield* supervisor.enable(calm);
        const floodPid = pidOf(yield* supervisor.invoke(flood.manifest.id, "ping", null));
        const calmPid = pidOf(yield* supervisor.invoke(calm.manifest.id, "ping", null));

        // About 2.4 MB of logs in one synchronous burst against a 64 KiB read budget.
        const flooding = yield* supervisor
          .invoke(flood.manifest.id, "flood", { count: 8000, size: 250 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(yield* supervisor.invoke(calm.manifest.id, "ping", "meanwhile")).toEqual({
          pid: calmPid,
          input: "meanwhile",
        });
        expect(yield* Fiber.join(flooding)).toEqual({ pid: floodPid, done: true });
        // The child saw the server stop reading and dropped logs, not the result.
        const notice = yield* awaitLogMatching(subscription, flood.manifest.id, /^Dropped \d+ /);
        expect(notice).toMatch(/^Dropped \d+ log messages while the server was busy\.$/);
        expect(pidOf(yield* supervisor.invoke(flood.manifest.id, "ping", null))).toBe(floodPid);
      }),
    );

    it.effect("bounds call and result sizes without stopping the plugin", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const { registration } = yield* preparePlugin("test.bounds");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const pid = pidOf(yield* supervisor.invoke(pluginId, "ping", null));

        const bigInput = yield* supervisor
          .invoke(pluginId, "ping", "x".repeat(70_000))
          .pipe(Effect.flip);
        expect(bigInput._tag).toBe("PluginPayloadTooLargeError");
        const bigResult = yield* supervisor
          .invoke(pluginId, "bigResult", { bytes: 70_000 })
          .pipe(Effect.flip);
        expect(bigResult._tag).toBe("PluginCallFailedError");
        expect(bigResult.message).toContain("Result exceeds 65536 bytes");
        const thrown = yield* supervisor.invoke(pluginId, "throws", null).pipe(Effect.flip);
        expect(thrown.message).toBe('Plugin test.bounds failed "throws": nope');
        expect(pidOf(yield* supervisor.invoke(pluginId, "ping", null))).toBe(pid);
      }),
    );

    it.effect("keeps one plugin's crash away from another", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const crasher = (yield* preparePlugin("test.crasher")).registration;
        const survivor = (yield* preparePlugin("test.survivor")).registration;
        yield* supervisor.enable(crasher);
        yield* supervisor.enable(survivor);
        const survivorPid = pidOf(yield* supervisor.invoke(survivor.manifest.id, "ping", null));

        const crash = yield* supervisor.invoke(crasher.manifest.id, "exit", null).pipe(Effect.flip);
        expect(crash._tag).toBe("PluginCrashedError");
        expect(crash.message).toContain("exited with code 3");
        expect(pidOf(yield* supervisor.invoke(survivor.manifest.id, "ping", null))).toBe(
          survivorPid,
        );
        expect(yield* supervisor.state(survivor.manifest.id)).toEqual(
          Option.some({ _tag: "running" }),
        );
      }),
    );

    it.effect("backs off after each crash and quarantines past the restart cap", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const subscription = yield* supervisor.subscribe;
        const { registration } = yield* preparePlugin("test.flaky");
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);

        const crashAndWait = Effect.fn("crashAndWait")(function* (delay: Duration.Input) {
          yield* supervisor.invoke(pluginId, "exit", null).pipe(Effect.flip);
          const backoff = yield* awaitState(supervisor, subscription, pluginId, "backoff");
          const refused = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
          expect(refused._tag).toBe("PluginUnavailableError");
          yield* TestClock.adjust(delay);
          yield* awaitState(supervisor, subscription, pluginId, "idle");
          return backoff;
        });
        expect((yield* crashAndWait("1 second")).failures).toBe(1);
        expect((yield* crashAndWait("2 seconds")).failures).toBe(2);

        yield* supervisor.invoke(pluginId, "exit", null).pipe(Effect.flip);
        const quarantined = yield* awaitState(supervisor, subscription, pluginId, "quarantined");
        expect(quarantined).toMatchObject({ failures: 3 });
        expect(quarantined.reason).toContain("exited with code 3");

        // Quarantine never lifts on its own.
        yield* TestClock.adjust("10 minutes");
        const refused = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
        expect(refused.message).toContain("quarantined after 3 failures");

        yield* supervisor.resume(pluginId);
        expect(yield* supervisor.invoke(pluginId, "ping", "back")).toMatchObject({ input: "back" });
      }),
    );

    it.effect("refuses top-level await in an entry or its imports without spending restarts", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        for (const [id, entry] of [
          ["test.async-entry", "asyncEntry.mjs"],
          ["test.async-dependency", "asyncDependency.mjs"],
        ] as const) {
          const { registration } = yield* preparePlugin(id, { entry });
          const pluginId = registration.manifest.id;
          yield* supervisor.enable(registration);
          // More attempts than the restart cap allows still never back off or quarantine.
          for (let attempt = 0; attempt <= testOptions.maxRestarts + 1; attempt++) {
            const error = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
            expect(error._tag).toBe("PluginIncompatibleError");
            expect(error.message).toContain("uses top-level await");
            const state = Option.getOrUndefined(yield* supervisor.state(pluginId));
            expect(state?._tag).toBe("incompatible");
            // Refused up front until someone resumes it.
            const again = yield* supervisor.invoke(pluginId, "ping", null).pipe(Effect.flip);
            expect(again._tag).toBe("PluginIncompatibleError");
            yield* supervisor.resume(pluginId);
          }
        }
      }),
    );

    it.effect("fails activation that hangs, throws, or uses unrequested proposed APIs", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor();
        const hang = (yield* preparePlugin("test.hang", { entry: "spinActivate.mjs" }))
          .registration;
        const refuse = (yield* preparePlugin("test.refuse", { entry: "failActivate.mjs" }))
          .registration;
        const stable = (yield* preparePlugin("test.stable", { proposedApi: false })).registration;
        yield* Effect.forEach([hang, refuse, stable], supervisor.enable, { discard: true });

        const hanging = yield* supervisor
          .invoke(hang.manifest.id, "ping", null)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("5 seconds");
        expect((yield* Fiber.join(hanging)).message).toContain("did not activate within 5000ms");

        const refused = yield* supervisor
          .invoke(refuse.manifest.id, "ping", null)
          .pipe(Effect.flip);
        expect(refused.message).toContain("activation failed: activation refused");

        const gated = yield* supervisor.invoke(stable.manifest.id, "ping", null).pipe(Effect.flip);
        expect(gated.message).toContain("activation failed");
      }),
    );
  });
});
