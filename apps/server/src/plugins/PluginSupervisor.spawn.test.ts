// @effect-diagnostics nodeBuiltinImport:off -- Models Node's failed-spawn child and its next-tick error.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof NodeChildProcess>()),
  spawn: vi.fn(),
}));

it.layer(NodeServices.layer)("PluginSupervisor failed spawn", (it) => {
  it.effect.each(["EMFILE", "ENFILE"])(
    "supervises %s without stdio before Node emits error",
    (code) =>
      Effect.gen(function* () {
        const child = Object.assign(new NodeEvents.EventEmitter(), {
          pid: undefined,
          stdio: undefined,
          kill: vi.fn(),
        });
        vi.mocked(NodeChildProcess.spawn).mockReturnValueOnce(
          child as unknown as ReturnType<typeof NodeChildProcess.spawn>,
        );
        const supervisor = yield* PluginSupervisor.make().pipe(
          Effect.provideService(HostProcess.Arguments, [
            process.execPath,
            `${import.meta.dirname}/../bin.ts`,
          ]),
        );
        const registration = yield* loadPluginDirectory(
          `${import.meta.dirname}/testFixtures/plugin`,
        );
        yield* supervisor.enable(registration);
        const outcome = yield* supervisor
          .invoke(registration.manifest.id, "ping", null)
          .pipe(Effect.flip);
        expect(outcome._tag).toBe("PluginUnavailableError");
        expect(yield* supervisor.state(registration.manifest.id)).toEqual(
          Option.some({ _tag: "idle" }),
        );
        expect(child.listenerCount("error")).toBeGreaterThan(0);
        child.emit("error", Object.assign(new Error(`spawn ${code}`), { code }));
        expect(child.kill).not.toHaveBeenCalled();
        yield* supervisor.disable(registration.manifest.id);
      }),
  );
  it.effect("destroys inherited streams when shutdown interrupts the exit drain", () =>
    Effect.gen(function* () {
      const activated = yield* Deferred.make<void>();
      const stderr = new NodeStream.PassThrough();
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null,
        stderr,
        kill: vi.fn(),
      });
      const channel = new NodeStream.Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const message = JSON.parse(chunk.toString());
          if (message._tag === "Activate") Deferred.doneUnsafe(activated, Exit.void);
          if (message._tag === "Deactivate") {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          }
          callback();
        },
      });
      Object.assign(child, { stdio: [null, null, stderr, channel] });
      vi.mocked(NodeChildProcess.spawn).mockReturnValueOnce(
        child as unknown as ReturnType<typeof NodeChildProcess.spawn>,
      );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const supervisor = yield* PluginSupervisor.make().pipe(
        Effect.provideService(HostProcess.Arguments, [
          process.execPath,
          `${import.meta.dirname}/../bin.ts`,
        ]),
        Scope.provide(scope),
      );
      const registration = yield* loadPluginDirectory(`${import.meta.dirname}/testFixtures/plugin`);
      yield* supervisor.enable(registration);
      const pending = yield* supervisor
        .invoke(registration.manifest.id, "ping", null)
        .pipe(Effect.forkChild);
      yield* Deferred.await(activated);
      yield* supervisor.disable(registration.manifest.id);
      yield* Fiber.await(pending);
      yield* Scope.close(scope, Exit.void);
      expect(channel.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
    }),
  );
});
