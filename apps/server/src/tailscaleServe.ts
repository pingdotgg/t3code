import {
  claimTailscaleServe,
  readTailscaleProfiles,
  readTailscaleStatus,
  releaseTailscaleServe,
} from "@t3tools/tailscale";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  reason: Schema.Literals(["unreadable", "no_account", "other_account", "switched", "unlisted"]),
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
  if (cause._tag === "ServeRecordError") {
    return cause.reason === "switched" || cause.reason === "unlisted"
      ? cause.message
      : `${cause.message} Serve waits until then.`;
  }
  if (cause._tag === "PlatformError") {
    return "Could not save the record that lets a later run remove the mapping, so Serve waits until it can.";
  }
  switch (cause._tag === "TailscaleCommandExitError" ? cause.stderrDiagnostic : undefined) {
    case "permission-denied":
      return "On Linux, run `sudo tailscale set --operator=$USER` to let this user configure Serve.";
    case "not-logged-in":
      return "Run `tailscale up` to sign in.";
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
// `profileId` is the login profile it was made on, when Tailscale listed one.
const ServeRecord = Schema.Struct({
  ...ServeTarget.fields,
  label: Schema.String,
  profileId: Schema.optionalKey(Schema.String),
  // Every key the account had when it was written, so a later read missing one still matches.
  keys: Schema.optionalKey(Schema.Array(Schema.String)),
  nodeId: Schema.optionalKey(Schema.String),
});
type ServeRecord = typeof ServeRecord.Type;
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

type Profiles = Effect.Success<ReturnType<typeof readTailscaleProfiles>> | null;
const readProfiles = readTailscaleProfiles().pipe(Effect.orElseSucceed((): Profiles => null));

/**
 * The Tailscale account whose Serve config is live now. Its `key` is the login profile ID,
 * the key Tailscale stores Serve config under, which tagging a host does not change. `keys`
 * also holds the keys earlier runs may have used for it: tailnet and user from a CLI too old
 * to list profiles, which outlives a node ID when a device is re-added, and the node ID.
 */
const currentAccount = Effect.fn("TailscaleServe.currentAccount")(function* (listed?: Profiles) {
  const profiles = listed === undefined ? yield* readProfiles : listed;
  const profile = profiles?.selected ?? null;
  const status = yield* readTailscaleStatus("active");
  const legacyKey =
    status.tailnetName !== null && status.selfUserId !== null
      ? `${status.tailnetName}/${status.selfUserId}`
      : null;
  const keys = [profile?.id ?? null, legacyKey, status.selfNodeId].filter((key) => key !== null);
  const key = keys[0];
  if (key === undefined) {
    return yield* new ServeRecordError({
      reason: "no_account",
      message: "Tailscale is not signed in here. Run `tailscale up` to sign in.",
    });
  }
  const login =
    profile?.account ??
    status.users.find((user) => user.userId === status.selfUserId)?.loginName ??
    null;
  const tailnet = profile?.tailnet ?? status.tailnetName;
  const label = [login, tailnet].filter((part) => part !== null).join(" on ") || key;
  return {
    key,
    keys,
    label,
    profileId: profile?.id ?? null,
    nodeId: status.selfNodeId,
    profiles: profiles?.ids ?? null,
  };
});

/** An account as a record or a read names it: every key it had, and its profile if listed. */
interface AccountKeys {
  readonly keys: ReadonlyArray<string>;
  readonly profileId: string | null;
  readonly nodeId: string | null;
}
// Two profiles can share a tailnet and user, as two Windows users signed in to one account.
// So known profile IDs decide alone, and with one side's profile unknown, node IDs do; other
// keys match only when neither side has a profile, as from a CLI too old to list them.
const sameAccount = (a: AccountKeys, b: AccountKeys) =>
  a.profileId !== null && b.profileId !== null
    ? a.profileId === b.profileId
    : (a.profileId !== null || b.profileId !== null) && a.nodeId !== null && b.nodeId !== null
      ? a.nodeId === b.nodeId
      : a.keys.some((key) => b.keys.includes(key));
const recordAccount = (key: string, record: ServeRecord): AccountKeys => ({
  keys: [key, ...(record.keys ?? [])],
  profileId: record.profileId ?? null,
  nodeId: record.nodeId ?? null,
});

/**
 * Sorts records by whose they are. `ours` belong to `account`. A record made on a login
 * profile Tailscale no longer lists is skipped: `tailscale logout` deleted its Serve config
 * with it. Windows lists only the signed-in Windows user's profiles, so absence proves
 * nothing there. `unlisted` were made on a profile, but Tailscale did not list profiles.
 */
const sortRecords = Effect.fn("TailscaleServe.sortRecords")(function* (
  records: ServeRecords,
  account: AccountKeys | null,
  profiles: Profiles,
) {
  const proofOfAbsence = profiles !== null && (yield* HostProcess.Platform) !== "win32";
  const sorted = {
    ours: [] as Array<ServeRecord>,
    others: {} as Record<string, ServeRecord>,
    unlisted: {} as Record<string, ServeRecord>,
  };
  for (const [key, record] of Object.entries(records)) {
    if (account !== null && sameAccount(recordAccount(key, record), account)) {
      sorted.ours.push(record);
    } else if (record.profileId === undefined) sorted.others[key] = record;
    else if (profiles === null) sorted.unlisted[key] = record;
    else if (proofOfAbsence && !profiles.ids.includes(record.profileId)) continue;
    else sorted.others[key] = record;
  }
  return sorted;
});

// A switch while removing a mapping means the removal may have run on the other account.
const switchedDuring = (account: AccountKeys) =>
  currentAccount().pipe(
    Effect.flatMap((now) =>
      sameAccount(now, account)
        ? Effect.void
        : Effect.fail(
            new ServeRecordError({
              reason: "switched",
              message: "Tailscale switched accounts during cleanup.",
            }),
          ),
    ),
  );

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
      // The keys of the account this run's mapping is recorded under, once it is.
      const account = yield* Ref.make<AccountKeys | null>(null);
      // An earlier run's mapping on this account that must go before this one is recorded.
      const releasing = yield* Ref.make<ServeTarget | null>(null);
      // Added before the retry fiber is forked, so it runs after that fiber is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const recordedUnder = yield* Ref.get(account);
          if (recordedUnder === null) return;
          // After a switch to another account, the mapping is not visible, so its record stays.
          if (!sameAccount(yield* currentAccount(), recordedUnder)) return;
          const released = yield* releaseTailscaleServe(target).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to disable Tailscale Serve", { cause, ...logContext }),
            ),
          );
          if (released) yield* Effect.logInfo("Tailscale Serve disabled", logContext);
          yield* switchedDuring(recordedUnder);
          const records = yield* readRecords(options.stateDir);
          yield* writeRecords(
            options.stateDir,
            Object.fromEntries(
              Object.entries(records).filter(
                ([key, record]) => !sameAccount(recordAccount(key, record), recordedUnder),
              ),
            ),
          );
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
        yield* Ref.set(releasing, null);
        const profiles = yield* readProfiles;
        const now = yield* currentAccount(profiles);
        const recordedUnder = yield* Ref.get(account);
        if (recordedUnder === null || !sameAccount(now, recordedUnder)) {
          // An unreadable record may name a mapping to remove, so Serve waits for it.
          const records = yield* readRecords(options.stateDir);
          const { ours, others, unlisted } = yield* sortRecords(records, now, profiles);
          for (const earlier of ours.filter((record) => !sameTarget(record, target))) {
            yield* Ref.set(releasing, earlier);
            yield* releaseTailscaleServe(earlier);
            yield* Ref.set(releasing, null);
          }
          // Its record is replaced only once its mapping is gone from this account.
          if (ours.length > 0) yield* switchedDuring(now);
          yield* writeRecords(options.stateDir, {
            ...others,
            ...unlisted,
            [now.key]: {
              ...target,
              label: now.label,
              keys: now.keys,
              ...(now.nodeId === null ? {} : { nodeId: now.nodeId }),
              ...(now.profileId === null ? {} : { profileId: now.profileId }),
            },
          });
          yield* Ref.set(account, {
            keys: now.keys,
            profileId: now.profileId,
            nodeId: now.nodeId,
          });
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
  if (Object.keys(records).length === 0) {
    return { released: false, otherAccounts: [], currentLabel: null };
  }
  const profiles = yield* readProfiles;
  // Signed out, a record can still be one `tailscale logout` deleted the profile of.
  const now = yield* currentAccount(profiles).pipe(
    Effect.catchTags({
      ServeRecordError: (error) =>
        error.reason === "no_account" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  const { ours, others, unlisted } = yield* sortRecords(records, now, profiles);
  let released = false;
  for (const record of ours) {
    if (yield* releaseTailscaleServe(record)) released = true;
  }
  if (now !== null && ours.length > 0) yield* switchedDuring(now);
  yield* writeRecords(stateDir, { ...others, ...unlisted });
  if (Object.keys(unlisted).length > 0) {
    return yield* new ServeRecordError({
      reason: "unlisted",
      message:
        "Tailscale did not list its accounts, so T3 Code cannot tell whose Serve mapping an earlier run left.",
    });
  }
  if (now === null && Object.keys(others).length > 0) {
    return yield* new ServeRecordError({
      reason: "no_account",
      message: "Tailscale is not signed in here. Run `tailscale up` to sign in.",
    });
  }
  return {
    released,
    otherAccounts: Object.values(others).map((record) => record.label),
    currentLabel: now?.label ?? null,
  };
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
