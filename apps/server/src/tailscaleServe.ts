import {
  claimTailscaleServe,
  readTailscaleStatus,
  releaseTailscaleServe,
} from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";

import { loopbackUrlHostForAddress } from "./startupAccess.ts";

/** The Serve record cannot be used: it is unreadable, or Tailscale names no account here. */
export class ServeRecordError extends Schema.TaggedError<ServeRecordError>()("ServeRecordError", {
  reason: Schema.Literals(["unreadable", "no_account", "other_account"]),
  message: Schema.String,
}) {}

type ClaimError =
  | Effect.Error<ReturnType<typeof claimTailscaleServe>>
  | Effect.Error<ReturnType<typeof readTailscaleStatus>>
  | PlatformError.PlatformError
  | ServeRecordError;

// Serve is often refused only for now: Tailscale still starting at login, the
// operator or HTTPS certs not yet granted, or another server on the port.
// Nobody restarts a headless server once that is fixed, so keep retrying.
const retrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);
// A leftover waits on a Tailscale that may be gone for good, so it backs off further.
const leftoverSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("10 minutes"),
]);

const remedyFor = (cause: ClaimError, manualCommand: string) => {
  if (cause._tag === "TailscaleServeOccupiedError") {
    return "Another server holds this port. T3 Code leaves it alone and takes over once it stops.";
  }
  if (cause._tag === "ServeRecordError") return `${cause.message} Serve waits until then.`;
  if (cause._tag === "PlatformError") {
    return "Could not save the record that lets a later run remove the mapping, so Serve waits until it can.";
  }
  switch (cause._tag === "TailscaleCommandExitError" ? cause.stderrDiagnostic : undefined) {
    case "permission-denied":
      return "On Linux, run `sudo tailscale set --operator=$USER` to let this user configure Serve.";
    case "not-logged-in":
      return "Run `tailscale up` to log in.";
    default:
      return `Run \`${manualCommand}\` by hand to see why.`;
  }
};

/**
 * The mapping this T3 home set up, per Tailscale account, since each account keeps its own
 * Serve config. A run with Serve off removes the current account's, such as one left when
 * Tailscale was down as the last run stopped.
 */
const RECORD_FILE = "tailscale-serve-claim.json";
const ServeTarget = Schema.Struct({
  localPort: Schema.Number,
  localHost: Schema.String,
  servePort: Schema.Number,
});
type ServeTarget = typeof ServeTarget.Type;
// Keyed by account; `label` names it for a person, such as `you@example.com on example.com`.
const ServeRecord = Schema.Struct({ ...ServeTarget.fields, label: Schema.String });
const ServeRecords = Schema.fromJsonString(Schema.Record(Schema.String, ServeRecord));
type ServeRecords = typeof ServeRecords.Type;
const NO_RECORDS: ServeRecords = {};
const encodeRecords = Schema.encodeEffect(ServeRecords);
const decodeRecords = Schema.decodeUnknownEffect(ServeRecords);
const sameTarget = (a: ServeTarget, b: ServeTarget) =>
  a.localPort === b.localPort && a.localHost === b.localHost && a.servePort === b.servePort;

/** Where an earlier run's Serve mappings are recorded. */
export const recordPath = Effect.fn("TailscaleServe.recordPath")(function* (stateDir: string) {
  return (yield* Path.Path).join(stateDir, RECORD_FILE);
});

const readRecords = Effect.fn("TailscaleServe.readRecords")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* recordPath(stateDir);
  if (!(yield* fs.exists(path))) return NO_RECORDS;
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeRecords),
    Effect.mapError(
      () =>
        new ServeRecordError({
          reason: "unreadable",
          message: `The Tailscale Serve record at ${path} could not be read. Check \`tailscale serve status\`, then delete the file.`,
        }),
    ),
  );
});

// Written to a temporary file and renamed, so a crash never leaves half a record.
const writeRecords = Effect.fn("TailscaleServe.writeRecords")(function* (
  stateDir: string,
  records: ServeRecords,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* recordPath(stateDir);
  if (Object.keys(records).length === 0) return yield* fs.remove(path, { force: true });
  const json = yield* encodeRecords(records).pipe(Effect.orDie);
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(`${path}.tmp`, json);
  yield* fs.rename(`${path}.tmp`, path);
});

/**
 * The Tailscale account whose Serve config is live now. Tailscale keeps Serve config per
 * login profile, one user on one tailnet, which outlives a node ID when a device is re-added.
 */
const currentAccount = Effect.fn("TailscaleServe.currentAccount")(function* () {
  const status = yield* readTailscaleStatus("active");
  const login = status.users.find((user) => user.userId === status.selfUserId)?.loginName;
  const key =
    status.tailnetName !== null && status.selfUserId !== null
      ? `${status.tailnetName}/${status.selfUserId}`
      : status.selfNodeId;
  if (key === null) {
    return yield* new ServeRecordError({
      reason: "no_account",
      message: "Tailscale is not signed in here. Run `tailscale up` to sign in.",
    });
  }
  const label = [login, status.tailnetName].filter((part) => part != null).join(" on ") || key;
  return { key, label };
});

const failureKey = (cause: ClaimError) =>
  cause._tag === "TailscaleCommandExitError" ? `exit:${cause.stderrDiagnostic}` : cause._tag;

/**
 * Points Tailscale Serve at this server after activation and retries until it
 * succeeds. `settled` completes after the first attempt, so headless startup
 * can print the Serve URL. Shutdown removes the mapping only if it still points here.
 */
export const layer = (options: {
  readonly stateDir: string;
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly settled: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Deferred.succeed(options.parked, undefined).pipe(Effect.orDie);
      yield* options.awaitActivation;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        yield* Deferred.succeed(options.settled, undefined);
        return;
      }

      const target = {
        localPort: address.port,
        servePort: options.servePort,
        localHost: loopbackUrlHostForAddress(address),
      };
      const logContext = { localPort: target.localPort, servePort: target.servePort };
      const manualCommand = `tailscale serve --bg --https=${target.servePort} http://${target.localHost}:${target.localPort}`;
      // The account this run's mapping is recorded under, once it is.
      const account = yield* Ref.make<string | null>(null);
      // An earlier run's mapping on this account that must go before this one is recorded.
      const releasing = yield* Ref.make<ServeTarget | null>(null);
      // Added before the retry fiber is forked, so it runs after that fiber is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const recordedUnder = yield* Ref.get(account);
          if (recordedUnder === null) return;
          // After a switch to another account, the mapping is not visible, so its record stays.
          if ((yield* currentAccount()).key !== recordedUnder) return;
          const released = yield* releaseTailscaleServe(target).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to disable Tailscale Serve", { cause, ...logContext }),
            ),
          );
          if (released) yield* Effect.logInfo("Tailscale Serve disabled", logContext);
          const { [recordedUnder]: _ours, ...rest } = yield* readRecords(options.stateDir);
          yield* writeRecords(options.stateDir, rest);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Left the Tailscale Serve record for the next run", { cause }),
          ),
        ),
      );

      let lastFailure: string | undefined;
      // The daemon applies the mapping before the CLI exits, so an interrupt
      // between the two would leave it behind with nothing to remove it.
      // Shutdown waits for the commands' own timeouts instead.
      const attempt = Effect.gen(function* () {
        // Recorded before the claim, since a claim can apply the mapping and still fail.
        // Release removes only a root that points here, so it is safe when none landed.
        // Checked on every try, since Tailscale may have switched accounts since the last.
        const now = yield* currentAccount();
        if ((yield* Ref.get(account)) !== now.key) {
          // An unreadable record may name a mapping to remove, so Serve waits for it.
          const records = yield* readRecords(options.stateDir);
          const earlier = records[now.key];
          if (earlier !== undefined && !sameTarget(earlier, target)) {
            yield* Ref.set(releasing, earlier);
            yield* releaseTailscaleServe(earlier);
            yield* Ref.set(releasing, null);
          }
          yield* writeRecords(options.stateDir, {
            ...records,
            [now.key]: { ...target, label: now.label },
          });
          yield* Ref.set(account, now.key);
        }
        yield* claimTailscaleServe(target);
      }).pipe(
        Effect.uninterruptible,
        Effect.tap(() => Effect.logInfo("Tailscale Serve configured", logContext)),
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            const key = failureKey(cause);
            const repeated = key === lastFailure;
            lastFailure = key;
            const log = repeated ? Effect.logDebug : Effect.logWarning;
            const earlier = yield* Ref.get(releasing);
            yield* log(
              earlier !== null
                ? `Could not remove the Tailscale Serve mapping an earlier run left on port ${earlier.servePort}, so Serve waits. ${remedyFor(cause, `tailscale serve --https=${earlier.servePort} --set-path=/ off`)} Retrying in the background.`
                : `Failed to configure Tailscale Serve. ${remedyFor(cause, manualCommand)} Retrying in the background.`,
              { cause, ...logContext },
            );
          }),
        ),
        Effect.ensuring(Deferred.succeed(options.settled, undefined)),
      );

      yield* attempt.pipe(Effect.retry(retrySchedule), Effect.forkScoped);
    }),
  );

/** Whether an earlier run left a Serve record here. */
export const hasRecord = Effect.fn("TailscaleServe.hasRecord")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(yield* recordPath(stateDir));
});

/**
 * Removes the Serve mapping an earlier run recorded for the current Tailscale account, while
 * Serve still points there, then its record. Records for other accounts stay.
 */
export const releaseRecorded = Effect.fn("TailscaleServe.releaseRecorded")(function* (
  stateDir: string,
) {
  const records = yield* readRecords(stateDir);
  if (Object.keys(records).length === 0) return { released: false, otherAccounts: [] };
  const now = yield* currentAccount();
  const { [now.key]: ours, ...rest } = records;
  const released = ours === undefined ? false : yield* releaseTailscaleServe(ours);
  yield* writeRecords(stateDir, rest);
  return { released, otherAccounts: Object.values(rest).map((record) => record.label) };
});

/**
 * With Serve off, removes the mappings earlier runs set up but could not remove. Retries
 * until Tailscale answers, and until a record left on another account can be removed too.
 */
export const layerReleaseLeftover = (options: { readonly stateDir: string }) =>
  Layer.effectDiscard(
    releaseRecorded(options.stateDir).pipe(
      Effect.tap(({ released }) =>
        released
          ? Effect.logInfo("Removed the Tailscale Serve mapping left from when Serve was on")
          : Effect.void,
      ),
      Effect.flatMap(({ otherAccounts }) =>
        otherAccounts.length > 0
          ? Effect.fail(
              new ServeRecordError({
                reason: "other_account",
                message: "A Serve mapping is recorded for another Tailscale account.",
              }),
            )
          : Effect.void,
      ),
      Effect.tapError((cause) =>
        Effect.logDebug("Retrying the leftover Tailscale Serve removal", { cause }),
      ),
      Effect.retry({
        schedule: leftoverSchedule,
        // An unreadable record stays unreadable, so it is reported once.
        while: (error) => error._tag !== "ServeRecordError" || error.reason !== "unreadable",
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove the leftover Tailscale Serve record", { cause }),
      ),
      Effect.forkScoped,
    ),
  );
