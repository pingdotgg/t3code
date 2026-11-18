import {
  type Daemon,
  type DaemonDefinition,
  DaemonDefinition as DaemonDefinitionSchema,
  DaemonError,
  DaemonId,
  type DaemonIdInput,
  type DaemonListResult,
  type DaemonMutationResult,
  type DaemonStatus,
  type DaemonUpsertInput,
  daemonTerminalTarget,
  type TerminalEvent,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export const DAEMONS_FILE_NAME = "daemons.json";
const DAEMON_RUNNER_FILE_NAME = "daemon-run.sh";
export const DAEMON_MAX_BACKOFF_MS = 60_000;
/** A run this long counts as healthy, so the next crash restarts after the shortest delay. */
export const DAEMON_HEALTHY_RUN_MS = 60_000;

// The terminal runs this file as its shell, so the PTY exits with the command's own status.
const DAEMON_RUNNER_SCRIPT = `#!/bin/sh
command=$T3CODE_DAEMON_COMMAND
unset T3CODE_DAEMON_COMMAND T3CODE_TERMINAL_SHELL
/bin/sh -c "$command"
status=$?
printf '\\n[daemon exited with code %s]\\n' "$status"
exit "$status"
`;

const DaemonsFile = Schema.fromJsonString(
  Schema.Struct({ daemons: Schema.Array(DaemonDefinitionSchema) }),
);
const decodeDaemonsFile = Schema.decodeUnknownEffect(DaemonsFile);
const encodeDaemonsFile = Schema.encodeEffect(DaemonsFile);

export const daemonBackoffMs = (attempt: number) =>
  Math.min(1_000 * 2 ** attempt, DAEMON_MAX_BACKOFF_MS);

export class DaemonService extends Context.Service<
  DaemonService,
  {
    readonly list: () => Effect.Effect<DaemonListResult>;
    readonly subscribe: () => Stream.Stream<DaemonListResult>;
    readonly upsert: (input: DaemonUpsertInput) => Effect.Effect<DaemonMutationResult, DaemonError>;
    readonly delete: (input: DaemonIdInput) => Effect.Effect<{}, DaemonError>;
    readonly restart: (input: DaemonIdInput) => Effect.Effect<DaemonMutationResult, DaemonError>;
  }
>()("t3/daemons/DaemonService") {}

interface DaemonEntry {
  definition: DaemonDefinition;
  status: DaemonStatus;
  /** Bumped on every start and stop, so a late exit or timer from an older run is ignored. */
  run: number;
  attempt: number;
  startedAtMs: number;
}

const STOPPED: DaemonStatus = {
  state: "stopped",
  pid: null,
  startedAt: null,
  nextAttemptAt: null,
  lastExitCode: null,
  lastExitAt: null,
  lastError: null,
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const daemonError = (message: string, daemonId?: DaemonId, cause?: unknown) =>
  new DaemonError({
    message,
    ...(daemonId === undefined ? {} : { daemonId }),
    ...(cause === undefined ? {} : { cause }),
  });

const daemonIdFromTerminal = (event: TerminalEvent): DaemonId | null => {
  if (!event.threadId.startsWith("daemon:")) return null;
  const id = DaemonId.make(event.threadId.slice("daemon:".length));
  return daemonTerminalTarget(id).terminalId === event.terminalId ? id : null;
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const terminals = yield* TerminalManager.TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const serviceScope = yield* Effect.scope;
  const writeAtomically = (input: { readonly filePath: string; readonly contents: string }) =>
    writeFileStringAtomically(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const daemonsPath = path.join(config.stateDir, DAEMONS_FILE_NAME);
  const runnerPath = path.join(config.stateDir, DAEMON_RUNNER_FILE_NAME);
  const entries = new Map<DaemonId, DaemonEntry>();
  const lock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(lock.withPermits(1));
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const toDaemon = (entry: DaemonEntry): Daemon => ({ ...entry.definition, status: entry.status });

  const list: DaemonService["Service"]["list"] = () =>
    Effect.sync(() => ({
      daemons: [...entries.values()]
        .map(toDaemon)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    }));

  const persist = Effect.fn("DaemonService.persist")(function* () {
    const contents = yield* encodeDaemonsFile({
      daemons: [...entries.values()].map((entry) => entry.definition),
    }).pipe(Effect.orDie);
    yield* writeAtomically({ filePath: daemonsPath, contents: `${contents}\n` }).pipe(
      Effect.mapError((cause) => daemonError("Could not save daemons.", undefined, cause)),
    );
  });

  const exited = Effect.fn("DaemonService.exited")(function* (
    entry: DaemonEntry,
    exitCode: number | null,
    error: string | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (now - entry.startedAtMs >= DAEMON_HEALTHY_RUN_MS) entry.attempt = 0;
    const delay = daemonBackoffMs(entry.attempt);
    entry.attempt += 1;
    entry.run += 1;
    const run = entry.run;
    const id = entry.definition.id;
    entry.status = {
      ...entry.status,
      state: "restarting",
      pid: null,
      nextAttemptAt: iso(now + delay),
      lastExitCode: exitCode,
      lastExitAt: iso(now),
      lastError: error,
    };
    yield* Effect.sleep(delay).pipe(
      Effect.andThen(
        locked(
          Effect.suspend(() => {
            const current = entries.get(id);
            return current === entry && current.run === run ? start(current) : Effect.void;
          }),
        ),
      ),
      // Start now so the timer is armed before the status announces it.
      Effect.forkIn(serviceScope, { startImmediately: true }),
    );
    yield* notify;
  });

  // Callers hold the lock.
  const start: (entry: DaemonEntry) => Effect.Effect<void> = Effect.fn("DaemonService.start")(
    function* (entry: DaemonEntry) {
      const now = yield* Clock.currentTimeMillis;
      entry.run += 1;
      const run = entry.run;
      entry.startedAtMs = now;
      entry.status = {
        ...entry.status,
        state: "running",
        startedAt: iso(now),
        nextAttemptAt: null,
      };
      const { definition } = entry;
      const opened = yield* terminals
        .open(
          {
            ...daemonTerminalTarget(definition.id),
            cwd: definition.cwd,
            env: {
              T3CODE_TERMINAL_SHELL: runnerPath,
              T3CODE_DAEMON_COMMAND: definition.command,
            },
          },
          { keepHistory: true },
        )
        .pipe(Effect.result);
      if (entry.run !== run || entry.status.state !== "running") return;
      if (opened._tag === "Failure") {
        return yield* exited(entry, null, opened.failure.message);
      }
      entry.status = { ...entry.status, pid: opened.success.pid };
      yield* notify;
    },
  );

  // Callers hold the lock.
  const stop = Effect.fn("DaemonService.stop")(function* (
    entry: DaemonEntry,
    deleteHistory: boolean,
  ) {
    const wasStopped = entry.status.state === "stopped";
    entry.run += 1;
    entry.status = { ...entry.status, state: "stopped", pid: null, nextAttemptAt: null };
    if (wasStopped && !deleteHistory) return;
    yield* terminals
      .close({ ...daemonTerminalTarget(entry.definition.id), deleteHistory })
      .pipe(Effect.ignoreCause({ log: true }));
  });

  // Every terminal's events pass through here, including output, so it opens no span.
  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    if (event.type !== "exited" && event.type !== "closed" && event.type !== "error") return;
    const id = daemonIdFromTerminal(event);
    const entry = id === null ? undefined : entries.get(id);
    if (entry === undefined || entry.status.state !== "running") return;
    // Read the run now: the manager publishes a close inside `stop`, which already bumped it.
    const run = entry.run;
    const exitCode = event.type === "exited" ? event.exitCode : null;
    const error = event.type === "error" ? event.message : null;
    yield* locked(
      Effect.suspend(() =>
        entries.get(entry.definition.id) === entry &&
        entry.run === run &&
        entry.status.state === "running"
          ? exited(entry, exitCode, error)
          : Effect.void,
      ),
    ).pipe(Effect.forkIn(serviceScope));
  });

  const requireEntry = (id: DaemonId) => {
    const entry = entries.get(id);
    return entry === undefined
      ? Effect.fail(daemonError("That daemon no longer exists.", id))
      : Effect.succeed(entry);
  };

  const upsert: DaemonService["Service"]["upsert"] = Effect.fn("DaemonService.upsert")(
    function* (input) {
      return yield* locked(
        Effect.gen(function* () {
          const id =
            input.id ??
            DaemonId.make(
              yield* random
                .uuidV4()
                .pipe(
                  Effect.mapError((cause) =>
                    daemonError("Could not generate a daemon id.", undefined, cause),
                  ),
                ),
            );
          const definition: DaemonDefinition = {
            id,
            name: input.name,
            command: input.command,
            cwd: input.cwd,
            enabled: input.enabled,
          };
          const existing = entries.get(id);
          if (input.id !== undefined && existing === undefined) {
            return yield* daemonError("That daemon no longer exists.", id);
          }
          const entry: DaemonEntry = existing ?? {
            definition,
            status: STOPPED,
            run: 0,
            attempt: 0,
            startedAtMs: 0,
          };
          const launchChanged =
            existing !== undefined &&
            (existing.definition.command !== definition.command ||
              existing.definition.cwd !== definition.cwd);
          entry.definition = definition;
          entries.set(id, entry);
          yield* persist();
          if (!definition.enabled) {
            yield* stop(entry, false);
          } else if (launchChanged || entry.status.state === "stopped") {
            yield* stop(entry, false);
            entry.attempt = 0;
            yield* start(entry);
          }
          yield* notify;
          return { daemon: toDaemon(entry) };
        }),
      );
    },
  );

  const remove: DaemonService["Service"]["delete"] = Effect.fn("DaemonService.delete")(
    function* (input) {
      return yield* locked(
        Effect.gen(function* () {
          const entry = yield* requireEntry(input.id);
          yield* stop(entry, true);
          entries.delete(input.id);
          yield* persist();
          yield* notify;
          return {};
        }),
      );
    },
  );

  const restart: DaemonService["Service"]["restart"] = Effect.fn("DaemonService.restart")(
    function* (input) {
      return yield* locked(
        Effect.gen(function* () {
          const entry = yield* requireEntry(input.id);
          if (!entry.definition.enabled) {
            return yield* daemonError("Enable the daemon before restarting it.", input.id);
          }
          yield* stop(entry, false);
          entry.attempt = 0;
          yield* start(entry);
          yield* notify;
          return { daemon: toDaemon(entry) };
        }),
      );
    },
  );

  const subscribe: DaemonService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change between the two still arrives.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  yield* writeAtomically({ filePath: runnerPath, contents: DAEMON_RUNNER_SCRIPT }).pipe(
    Effect.andThen(fileSystem.chmod(runnerPath, 0o755)),
    Effect.catchCause((cause) => Effect.logError("Could not write the daemon runner.", { cause })),
  );
  const stored = yield* fileSystem.readFileString(daemonsPath).pipe(
    Effect.flatMap(decodeDaemonsFile),
    Effect.catchCause((cause) =>
      fileSystem.exists(daemonsPath).pipe(
        Effect.orElseSucceed(() => true),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logError("Could not read daemons.json; no daemons will start.", { cause })
            : Effect.void,
        ),
        Effect.as({ daemons: [] }),
      ),
    ),
  );
  for (const definition of stored.daemons) {
    entries.set(definition.id, { definition, status: STOPPED, run: 0, attempt: 0, startedAtMs: 0 });
  }

  const unsubscribe = yield* terminals.subscribe(onTerminalEvent);
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  yield* locked(
    Effect.forEach(
      [...entries.values()].filter((entry) => entry.definition.enabled),
      start,
      { discard: true },
    ),
  );

  return DaemonService.of({ list, subscribe, upsert, delete: remove, restart });
});

export const layer = Layer.effect(DaemonService, make);
