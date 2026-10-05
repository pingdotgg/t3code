import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class KiloCleanupError extends Schema.TaggedError<KiloCleanupError>()("KiloCleanupError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const Identity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
const Record = Schema.Struct({
  profile: Schema.String,
  // null means observation did not complete; it is not an empty process set.
  members: Schema.NullOr(Schema.Array(Identity)),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Record));
const encode = Schema.encodeEffect(Schema.fromJsonString(Record));
const gates = new Map<string, { lock: Semaphore.Semaphore; unrecorded: Set<number> }>();
const failure = () =>
  new KiloCleanupError({
    detail:
      "Kilo process cleanup could not be confirmed. Replacement remains blocked; check process and state-directory access before retrying.",
  });

/** Linux observation only: not a sandbox, process-tree discovery or atomic signal identity. */
export const make = Effect.fn("KiloProcessCleanup.make")(function* (input: {
  readonly profile: string;
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Create the owned directory before canonicalizing: first-open aliases must use
  // the same gate and record namespace as subsequent opens through the real path.
  yield* fs.makeDirectory(input.profile, { recursive: true }).pipe(Effect.mapError(failure));
  const profile = yield* fs.realPath(input.profile).pipe(Effect.mapError(failure));
  const crypto = yield* Crypto.Crypto;
  const key = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(profile))
    .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(failure));
  let gate = gates.get(profile);
  if (!gate) {
    gate = { lock: Semaphore.makeUnsafe(1), unrecorded: new Set() };
    gates.set(profile, gate);
  }
  const handoff = gate;
  const directory = path.join(input.stateDir, "kilo-cleanup", key);
  const observe = (pid: number) =>
    fs.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.flatMap((stat) => {
        const fields = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/);
        if (
          !stat.startsWith(`${pid} (`) ||
          !/^[A-Za-z]$/.test(fields[0] ?? "") ||
          !/^\d+$/.test(fields[2] ?? "") ||
          !/^\d+$/.test(fields[19] ?? "")
        )
          return Effect.fail(failure());
        return Effect.succeed({
          pid,
          startTime: fields[19]!,
          pgid: Number(fields[2]),
          stopped: fields[0] === "Z" || fields[0] === "X" || fields[0] === "x",
        });
      }),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(failure()),
      ),
    );
  const wait = (members: ReadonlyArray<typeof Identity.Type>) =>
    Effect.gen(function* () {
      for (;;) {
        const statuses = yield* Effect.forEach(
          members,
          (member) =>
            observe(member.pid).pipe(
              Effect.map(
                (current) =>
                  current === undefined ||
                  current.startTime !== member.startTime ||
                  current.stopped,
              ),
            ),
          { concurrency: 8 },
        );
        if (statuses.every(Boolean)) return;
        // A bounded condition-driven OS observation, never a fixed cleanup grace assertion.
        yield* Effect.sleep("10 millis");
      }
    }).pipe(Effect.timeout("2 seconds"), Effect.mapError(failure));
  const snapshot = (pgid: number) =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory("/proc").pipe(Effect.mapError(failure));
      const observed = yield* Effect.forEach(
        names.filter((name) => /^\d+$/.test(name)),
        (name) => observe(Number(name)),
        { concurrency: 16 },
      );
      return observed.flatMap((item) => (item !== undefined && item.pgid === pgid ? [item] : []));
    });
  // For incomplete snapshots, a successful fresh group scan must prove quiescence.
  // This never signals newly discovered PIDs, nor claims to find escaped descendants.
  const confirmGroup = (pgid: number) =>
    snapshot(pgid).pipe(
      Effect.flatMap((members) =>
        members.every((member) => member.stopped) ? Effect.void : Effect.fail(failure()),
      ),
    );
  const entries = fs.readDirectory(directory).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([] as Array<string>) : Effect.fail(error),
    ),
    Effect.mapError(failure),
  );
  const save = (file: string, members: (typeof Record.Type)["members"]) =>
    Effect.gen(function* () {
      const temporary = `${file}.tmp`;
      yield* fs
        .writeFileString(temporary, yield* encode({ profile, members }))
        .pipe(Effect.mapError(failure));
      // Same-directory rename keeps the previous uncertainty record readable if a
      // later write is interrupted or partially fails. This is not a power-loss fsync guarantee.
      yield* fs.rename(temporary, file).pipe(Effect.mapError(failure));
    });
  const recover = Effect.gen(function* () {
    for (const pgid of handoff.unrecorded) {
      yield* confirmGroup(pgid);
      // A working read is not proof that writes have recovered.
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure));
      const file = path.join(directory, `${pgid}.json`);
      yield* save(file, []);
      yield* fs.remove(file).pipe(Effect.mapError(failure));
      handoff.unrecorded.delete(pgid);
    }
    for (const name of yield* entries) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      const record = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(decode), Effect.mapError(failure));
      if (record.profile !== profile) continue;
      if (record.members === null) yield* confirmGroup(Number(name.slice(0, -5)));
      else yield* wait(record.members);
      yield* fs.remove(file).pipe(Effect.mapError(failure));
    }
  });
  const verify = (pgid: number, stop: Effect.Effect<void>) =>
    Effect.gen(function* () {
      handoff.unrecorded.add(pgid);
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure));
      const file = path.join(directory, `${pgid}.json`);
      // Persist uncertainty before taking a snapshot or delivering any signal.
      yield* save(file, null);
      handoff.unrecorded.delete(pgid);
      const members = (yield* snapshot(pgid)).map(({ pid, startTime }) => ({ pid, startTime }));
      yield* save(file, members);
      yield* stop;
      yield* wait(members);
      yield* fs.remove(file).pipe(Effect.mapError(failure));
    });
  return {
    // A short start/cleanup gate, not a session-lifetime lock: live sessions may coexist.
    withStart: <A, E, R>(start: Effect.Effect<A, E, R>) =>
      handoff.lock.withPermit(
        recover.pipe(Effect.timeout("5 seconds"), Effect.mapError(failure), Effect.andThen(start)),
      ),
    verify: (pgid: number, stop: Effect.Effect<void>) =>
      handoff.lock.withPermit(
        verify(pgid, stop).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(failure),
          Effect.interruptible,
        ),
      ),
  };
});
