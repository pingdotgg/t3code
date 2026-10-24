import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopOwnerIdentity from "./DesktopOwnerIdentity.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";

/**
 * The persisted runtime record a server writes for the T3 home it owns. It
 * names the pid, the port and the origin of that server.
 */
export const DesktopServerRuntimeRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
  // Set when a desktop app started the server, so a later desktop launch can
  // tell its own leftover apart from a server the user started by hand.
  desktopOwnerId: Schema.optional(Schema.String),
});
export type DesktopServerRuntimeRecord = typeof DesktopServerRuntimeRecord.Type;

const decodeServerRuntimeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopServerRuntimeRecord),
);

/**
 * How the recorded owner of the T3 home relates to this desktop app.
 *
 * - `none`: nobody owns the home. The desktop may start its own server.
 * - `healthy`: a server is running and answering its environment descriptor.
 *   The desktop must not start a second writer for the same home.
 * - `stranded`: a server this desktop started is still running and holds the
 *   home's ownership lock, but it is not answering. It is the leftover of an
 *   earlier desktop run and can be recovered.
 * - `foreign`: a server owns the home and this desktop cannot prove it
 *   started that server. It is left alone.
 * - `unknown`: the home's ownership record exists but cannot be read, so the
 *   desktop cannot establish who owns the home. It starts nothing and reports
 *   the state, because a record it cannot read is not evidence that the home
 *   is free.
 */
export type DesktopServerOwner =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "healthy";
      readonly record: DesktopServerRuntimeRecord;
      readonly httpBaseUrl: URL;
      readonly ownedByThisDesktop: boolean;
    }
  | {
      readonly _tag: "stranded";
      readonly record: DesktopServerRuntimeRecord;
    }
  | {
      readonly _tag: "foreign";
      readonly record: DesktopServerRuntimeRecord;
    }
  | { readonly _tag: "unknown" };

export class DesktopServerOwnership extends Context.Service<
  DesktopServerOwnership,
  {
    /**
     * Read the T3 home's ownership record and classify its owner. Never
     * starts, stops or signals anything.
     */
    readonly inspect: Effect.Effect<DesktopServerOwner>;
    /**
     * The path of the persisted runtime record for this desktop's T3 home.
     */
    readonly runtimeStatePath: Effect.Effect<string>;
  }
>()("@t3tools/desktop/backend/DesktopServerOwnership") {}

const { logInfo: logOwnershipInfo, logWarning: logOwnershipWarning } =
  DesktopObservability.makeComponentLogger("desktop-server-ownership");

/**
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
 * means it exists but belongs to another user, which still counts as alive.
 */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Whether the recorded pid still belongs to the server that wrote the
 * record. A pid is reused once the process that held it is gone, and the
 * record survives a server that died without clearing it. Recovering a
 * recycled pid would signal an unrelated process, so the process start time
 * is compared with the time the record was written.
 *
 * The comparison mirrors the server's own ownership check: an unreadable
 * start time is treated as "the same process", because that is the safe
 * direction.
 */
const recordedProcessStillOwns = Effect.fn("desktop.serverOwnership.recordedProcessStillOwns")(
  function* (
    record: DesktopServerRuntimeRecord,
    platform: NodeJS.Platform,
  ): Effect.fn.Return<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
    const recordedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(recordedAt)) {
      return true;
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command =
      platform === "win32"
        ? ChildProcess.make(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
            ],
            { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
          )
        : ChildProcess.make("ps", ["-p", String(record.pid), "-o", "lstart="], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            env: { LC_ALL: "C", TZ: "UTC" },
          });
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command);
        const bytes = yield* Stream.runCollect(handle.stdout);
        const exitCode = yield* handle.exitCode;
        return { text: Buffer.concat(bytes).toString("utf8"), exitCode };
      }),
    ).pipe(
      Effect.timeoutOption(Duration.seconds(2)),
      // A probe that cannot run is not proof of anything, so the pid is
      // treated as the same process: the desktop never signals a process it
      // cannot identify.
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(output)) {
      // The probe did not answer. Treating the pid as the same process is the
      // safe direction: the desktop never signals a process it cannot identify.
      return true;
    }
    if (output.value.exitCode !== 0) {
      // The process is gone: `ps` reports no such pid.
      return false;
    }
    const text = output.value.text.trim();
    const startedAt = Date.parse(platform === "win32" ? text : `${text} UTC`);
    if (!Number.isFinite(startedAt)) {
      return true;
    }
    // The process must have started before the record was written. A process
    // that started later is a different one that reused the pid.
    return startedAt <= recordedAt + 1_000;
  },
);

/**
 * The outcome of reading the home's ownership record.
 *
 * - `missing`: no server has written a record for this home, so the home is
 *   free.
 * - `unreadable`: a record exists but cannot be read or decoded. The desktop
 *   cannot establish who owns the home.
 * - `read`: the record names the owner.
 */
/** What the file read produced, before the record is decoded. */
type RecordContents =
  | { readonly _tag: "missing" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "contents"; readonly contents: string };

type RuntimeRecordRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "read"; readonly record: DesktopServerRuntimeRecord };

const readRuntimeRecord = Effect.fn("desktop.serverOwnership.readRuntimeRecord")(function* (
  path: string,
): Effect.fn.Return<RuntimeRecordRead, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(path).pipe(
    Effect.matchEffect({
      // A missing record means nobody has started a server for this home yet.
      // Any other read failure is worth reporting: the home may be owned by a
      // server whose record we could not read.
      onFailure: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<RecordContents>({ _tag: "missing" })
          : logOwnershipWarning("could not read the server runtime record", {
              path,
              cause,
            }).pipe(Effect.as<RecordContents>({ _tag: "unreadable" })),
      onSuccess: (contents) => Effect.succeed<RecordContents>({ _tag: "contents", contents }),
    }),
  );
  if (raw._tag === "missing") {
    return { _tag: "missing" };
  }
  if (raw._tag === "unreadable") {
    // The read failed for a reason other than a missing file, so the home may
    // be owned and the desktop cannot tell.
    return { _tag: "unreadable" };
  }
  const trimmed = raw.contents.trim();
  if (trimmed.length === 0) {
    yield* logOwnershipWarning("the server runtime record is empty", { path });
    return { _tag: "unreadable" };
  }
  const decoded = yield* decodeServerRuntimeRecord(trimmed).pipe(
    Effect.map((record): RuntimeRecordRead => ({ _tag: "read", record })),
    Effect.catchCause((cause) =>
      logOwnershipWarning("could not decode the server runtime record", {
        path,
        cause,
      }).pipe(Effect.as<RuntimeRecordRead>({ _tag: "unreadable" })),
    ),
  );
  return decoded;
});

/**
 * Probe the recorded server's environment descriptor. A server that owns the
 * home and answers this probe is healthy; one that owns it and does not
 * answer is stranded.
 */
const probeEnvironment = Effect.fn("desktop.serverOwnership.probeEnvironment")(function* (
  httpClient: HttpClient.HttpClient,
  origin: string,
): Effect.fn.Return<boolean> {
  const request = HttpClientRequest.get(`${origin}${ENVIRONMENT_DESCRIPTOR_PATH}`);
  // A server that is not answering is the normal case here, not a failure,
  // so the transport error and the timeout both read as "not serving".
  const outcome = yield* httpClient
    .execute(request)
    .pipe(Effect.timeoutOption(Duration.seconds(2)), Effect.result);
  if (outcome._tag === "Failure") {
    return false;
  }
  const response = outcome.success;
  if (Option.isNone(response)) {
    return false;
  }
  if (response.value.status !== 200) {
    return false;
  }
  return true;
});

const OWNERSHIP_PROBE_ATTEMPTS = 3;

/**
 * Probe the owner more than once before calling it stranded. A server that is
 * busy answering a long request can miss a single probe, and recovering it
 * would interrupt work it was doing.
 *
 * The probes are not spaced out: a server that does not answer costs the
 * request timeout on every attempt, so an unresponsive owner already gets
 * several seconds of grace, while a server that answers gets a prompt
 * verdict.
 */
const probeOwnerUntilAnswered = Effect.fn("desktop.serverOwnership.probeOwnerUntilAnswered")(
  function* (httpClient: HttpClient.HttpClient, origin: string): Effect.fn.Return<boolean> {
    for (let attempt = 1; attempt <= OWNERSHIP_PROBE_ATTEMPTS; attempt += 1) {
      if (yield* probeEnvironment(httpClient, origin)) {
        return true;
      }
    }
    return false;
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownerIdentity = yield* DesktopOwnerIdentity.DesktopOwnerIdentity;

  // The desktop's server writes its runtime record next to the ownership
  // lock, in the same state directory the server uses. The desktop resolves
  // its state directory the same way the server does, so a development
  // desktop finds a development server's record.
  const runtimeStatePath = environment.path.join(environment.stateDir, "server-runtime.json");
  const inspect = Effect.fn("desktop.serverOwnership.inspect")(function* (): Effect.fn.Return<
    DesktopServerOwner,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const read = yield* readRuntimeRecord(runtimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    if (read._tag === "missing") {
      return { _tag: "none" } as const;
    }
    if (read._tag === "unreadable") {
      // A record the desktop cannot read is not evidence that the home is
      // free, so the desktop establishes nothing and starts nothing.
      yield* logOwnershipWarning("the server runtime record could not be read", {
        path: runtimeStatePath,
      });
      return { _tag: "unknown" } as const;
    }

    const value = read.record;
    if (!isProcessAlive(value.pid)) {
      // The recorded server is gone. Its lock is released with it, so the
      // home is free.
      return { _tag: "none" } as const;
    }

    // A pid is reused once the process that held it is gone, and the record
    // outlives a server that died without clearing it. Recovering a recycled
    // pid would signal an unrelated process, so the pid must still belong to
    // the server that wrote the record.
    const sameProcess = yield* recordedProcessStillOwns(value, environment.platform);
    if (!sameProcess) {
      yield* logOwnershipInfo("the recorded server is gone; the pid was reused", {
        pid: value.pid,
      });
      return { _tag: "none" } as const;
    }

    // Only a server this desktop started may be recovered. A server the user
    // started by hand, or a background service runs, is not ours to signal.
    const ourOwnerId = yield* ownerIdentity.ownerId.pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        logOwnershipWarning("could not read the desktop owner identity", { cause }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );
    // A desktop that cannot name itself owns no server, so it recovers none.
    const ownedByThisDesktop =
      Option.isSome(ourOwnerId) && value.desktopOwnerId === ourOwnerId.value;

    const healthy = yield* probeOwnerUntilAnswered(httpClient, value.origin);
    if (healthy) {
      yield* logOwnershipInfo("a server already owns this T3 home", {
        pid: value.pid,
        port: value.port,
        origin: value.origin,
        ownedByThisDesktop,
      });
      return {
        _tag: "healthy",
        record: value,
        httpBaseUrl: new URL(value.origin),
        ownedByThisDesktop,
      } as const;
    }

    if (!ownedByThisDesktop) {
      yield* logOwnershipWarning("another server owns this T3 home and is not answering", {
        pid: value.pid,
      });
      return { _tag: "foreign", record: value } as const;
    }

    return { _tag: "stranded", record: value } as const;
  });

  return DesktopServerOwnership.of({
    // The spawner requirement is resolved here, so callers of the service
    // never have to provide it.
    inspect: inspect().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    runtimeStatePath: Effect.succeed(runtimeStatePath),
  });
});

export const layer = Layer.effect(DesktopServerOwnership, make);
