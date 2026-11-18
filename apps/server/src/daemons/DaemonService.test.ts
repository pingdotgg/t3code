import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type Daemon,
  type DaemonId,
  daemonTerminalTarget,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as DaemonService from "./DaemonService.ts";

const fakeTerminals = () => {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const opens: TerminalOpenInput[] = [];
  const closes: TerminalCloseInput[] = [];
  let pid = 100;
  const layer = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.sync(() => {
        opens.push(input);
        pid += 1;
        return {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: null,
          status: "running" as const,
          pid,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "",
          updatedAt: "",
        };
      }),
    close: (input) => Effect.sync(() => void closes.push(input)),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      }),
  });
  const exit = (id: DaemonId, exitCode: number) =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        listener({ type: "exited", ...daemonTerminalTarget(id), exitCode, exitSignal: null }),
      { discard: true },
    );
  return { layer, opens, closes, exit };
};

const boot = (baseDir: string, terminals: ReturnType<typeof fakeTerminals>) =>
  DaemonService.make.pipe(
    Effect.provide(Layer.merge(terminals.layer, ServerConfig.layerTest(process.cwd(), baseDir))),
  );

const tempBaseDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "t3code-daemons-test-" }),
);

const waitFor = (
  service: DaemonService.DaemonService["Service"],
  id: DaemonId,
  predicate: (daemon: Daemon) => boolean,
) =>
  service.subscribe().pipe(
    Stream.map((result) => result.daemons.find((daemon) => daemon.id === id)),
    Stream.filter((daemon): daemon is Daemon => daemon !== undefined && predicate(daemon)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const restartDelay = ({ status }: Daemon) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(status.nextAttemptAt!)) -
  DateTime.toEpochMillis(DateTime.makeUnsafe(status.lastExitAt!));

const definition = { name: "maestro", command: "./queue.sh --loop .", cwd: "/tmp" };

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DaemonService", (it) => {
  it.effect("starts enabled daemons at boot and leaves disabled ones stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", DaemonService.DAEMONS_FILE_NAME),
          JSON.stringify({
            daemons: [
              { ...definition, id: "on", enabled: true },
              { ...definition, id: "off", name: "idle", enabled: false },
            ],
          }),
        );
        const terminals = fakeTerminals();
        const service = yield* boot(baseDir, terminals);

        expect(terminals.opens.map((input) => input.threadId)).toEqual(["daemon:on"]);
        expect(terminals.opens[0]?.env?.T3CODE_DAEMON_COMMAND).toBe(definition.command);
        expect(terminals.opens[0]?.cwd).toBe(definition.cwd);
        const { daemons } = yield* service.list();
        expect(daemons.map((daemon) => [daemon.id, daemon.status.state])).toEqual([
          ["off", "stopped"],
          ["on", "running"],
        ]);
      }),
    ),
  );

  it.effect("restarts an exited daemon with growing backoff that resets after a healthy run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect([0, 1, 2, 5, 6, 10].map(DaemonService.daemonBackoffMs)).toEqual([
          1_000, 2_000, 4_000, 32_000, 60_000, 60_000,
        ]);
        const terminals = fakeTerminals();
        const service = yield* boot(yield* tempBaseDir, terminals);
        const { daemon } = yield* service.upsert({ ...definition, enabled: true });
        expect(terminals.opens).toHaveLength(1);

        yield* terminals.exit(daemon.id, 3);
        const first = yield* waitFor(service, daemon.id, (d) => d.status.state === "restarting");
        expect(first.status.lastExitCode).toBe(3);
        expect(restartDelay(first)).toBe(1_000);
        yield* TestClock.adjust(999);
        expect(terminals.opens).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* waitFor(service, daemon.id, (d) => d.status.state === "running");
        expect(terminals.opens).toHaveLength(2);

        yield* terminals.exit(daemon.id, 1);
        const second = yield* waitFor(service, daemon.id, (d) => d.status.state === "restarting");
        expect(restartDelay(second)).toBe(2_000);
        yield* TestClock.adjust(2_000);
        yield* waitFor(service, daemon.id, (d) => d.status.state === "running");
        expect(terminals.opens).toHaveLength(3);

        yield* TestClock.adjust(DaemonService.DAEMON_HEALTHY_RUN_MS);
        yield* terminals.exit(daemon.id, 1);
        const healthy = yield* waitFor(service, daemon.id, (d) => d.status.state === "restarting");
        expect(restartDelay(healthy)).toBe(1_000);
      }),
    ),
  );

  it.effect("disabling stops the daemon and cancels its pending restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const terminals = fakeTerminals();
        const service = yield* boot(yield* tempBaseDir, terminals);
        const { daemon } = yield* service.upsert({ ...definition, enabled: true });
        yield* terminals.exit(daemon.id, 1);
        yield* waitFor(service, daemon.id, (d) => d.status.state === "restarting");

        const disabled = yield* service.upsert({ ...definition, id: daemon.id, enabled: false });
        expect(disabled.daemon.status.state).toBe("stopped");
        expect(terminals.closes).toEqual([
          { ...daemonTerminalTarget(daemon.id), deleteHistory: false },
        ]);
        yield* TestClock.adjust(DaemonService.DAEMON_MAX_BACKOFF_MS);
        yield* terminals.exit(daemon.id, 1);
        expect(terminals.opens).toHaveLength(1);
        expect((yield* service.list()).daemons[0]?.status.state).toBe("stopped");

        const enabled = yield* service.upsert({ ...definition, id: daemon.id, enabled: true });
        expect(enabled.daemon.status.state).toBe("running");
        expect(terminals.opens).toHaveLength(2);
      }),
    ),
  );

  it.effect("keeps definitions across a server restart and forgets deleted ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const first = fakeTerminals();
        const { daemon } = yield* Effect.scoped(
          Effect.flatMap(boot(baseDir, first), (service) =>
            service.upsert({ ...definition, enabled: true }),
          ),
        );

        const second = fakeTerminals();
        const restarted = yield* boot(baseDir, second);
        expect((yield* restarted.list()).daemons).toEqual([
          expect.objectContaining({ ...definition, id: daemon.id, enabled: true }),
        ]);
        expect(second.opens.map((input) => input.threadId)).toEqual([`daemon:${daemon.id}`]);

        yield* restarted.delete({ id: daemon.id });
        expect(second.closes).toEqual([
          { ...daemonTerminalTarget(daemon.id), deleteHistory: true },
        ]);
        const third = yield* boot(baseDir, fakeTerminals());
        expect((yield* third.list()).daemons).toEqual([]);
      }),
    ),
  );
});
