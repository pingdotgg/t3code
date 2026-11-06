// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
// A secret the user pasted in chat goes straight to such a file, with no card.
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type SecretReference,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

type SecretRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }>;
/** `undefined` names the value of a request without fields. */
type FieldName = string | undefined;
const fieldNames = (item: SecretRequestItem): ReadonlyArray<FieldName> =>
  item.fields?.map((field) => field.name) ?? [undefined];

/** The answer's value per field, or undefined when it does not answer exactly those fields. */
function answerValues(
  item: SecretRequestItem,
  answer: Exclude<SecretRequestAnswerInput["answer"], { readonly type: "decline" }>,
): ReadonlyArray<readonly [FieldName, string]> | undefined {
  if (item.fields === undefined)
    return "secret" in answer ? [[undefined, answer.secret]] : undefined;
  if (!("values" in answer)) return undefined;
  const { values } = answer;
  if (Object.keys(values).length !== item.fields.length) return undefined;
  const entries: Array<readonly [string, string]> = [];
  for (const field of item.fields) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
    if (value === undefined) return undefined;
    entries.push([field.name, value]);
  }
  return entries;
}

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's values to owner-only files, one per field. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<
      { readonly file: string } | { readonly files: { readonly [name: string]: string } },
      SecretRequestError
    >;
    /** Writes a secret the user pasted in chat to an owner-only file and returns its path. */
    readonly savePasted: (input: {
      readonly threadId: ThreadId;
      /** The provider session's namespace, so two sessions' keys never share a file. */
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly value: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const resolver = yield* SecretResolver.SecretResolver;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const mac = yield* Mac.Mac;
  // Keyed by the salt's hex text, as refs saved by earlier versions were.
  const refKey = yield* Mac.key(
    Mac.hmacSha256,
    new TextEncoder().encode(
      Hex.encode(yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie)),
    ),
  ).pipe(Effect.orDie);
  const refFor = (threadId: ThreadId, turnItemId: string, field?: string) =>
    mac
      .sign(
        refKey,
        new TextEncoder().encode(
          field === undefined
            ? `${threadId}\u0000${turnItemId}`
            : `${threadId}\u0000${turnItemId}\u0000${field}`,
        ),
      )
      .pipe(
        Effect.orDie,
        Effect.map((tag) => SecretRef.make(`${SECRET_REF_PREFIX}${Hex.encode(tag).slice(0, 32)}`)),
      );
  const removeAnswered = (threadId: ThreadId, item: SecretRequestItem) =>
    Effect.forEach(fieldNames(item), (field) =>
      refFor(threadId, item.id, field).pipe(Effect.flatMap((ref) => removeLogged(storeName(ref)))),
    );

  const readReference = Effect.fn("SecretRequests.readReference")(function* (
    reference: SecretReference,
  ) {
    // The resolver keeps failed reads for the server's life; a retry after unlocking must re-read.
    yield* resolver.invalidate([reference]);
    const [value] = yield* resolver.read([reference]);
    if (value === undefined || value.trim() === "") {
      return yield* new SecretRequestError({
        reason: "reference_unreadable",
        provider: yield* resolver.label(reference.provider),
      });
    }
    return value;
  });

  // One answer at a time: fields are stored one by one, so two racing answers could otherwise
  // each keep some of their values on one card.
  const answerLock = yield* Semaphore.make(1);
  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(function* (
    input,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "secret_request.answer": input.answer.type,
    });
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (item.secretStatus !== "pending") {
      return yield* new SecretRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
    // Create before recording so racing answers cannot overwrite values or show saved before storage.
    // Existing values on pending cards finish earlier saves whose recording failed.
    const values =
      input.answer.type === "decline"
        ? undefined
        : input.answer.type === "reference" && item.fields === undefined
          ? [[undefined, yield* readReference(input.answer.reference)] as const]
          : (answerValues(item, input.answer) ??
            (yield* new SecretRequestError({ reason: "fields_mismatch" })));
    if (values !== undefined) {
      const savedAt = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(values, ([field, value]) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStored({
            projectId: records.thread.projectId,
            value,
            savedAt,
          }).pipe(Effect.orDie);
          yield* store
            .create(
              storeName(yield* refFor(input.threadId, item.id, field)),
              new TextEncoder().encode(encoded),
            )
            .pipe(
              Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
              Effect.mapError(
                (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
              ),
            );
        }),
      ).pipe(Effect.tapError(() => removeAnswered(input.threadId, item)));
    }
    const secretStatus = values === undefined ? "declined" : "saved";
    yield* threadManagement
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
        threadId: input.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        label: item.label,
        reason: item.reason,
        ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
        ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
        ...(item.fields === undefined ? {} : { fields: item.fields }),
        secretStatus,
      })
      .pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        // Clear failed saves so the pending card can be answered again.
        Effect.tapError(() =>
          values !== undefined ? removeAnswered(input.threadId, item) : Effect.void,
        ),
      );
    if (values === undefined) return;
    // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
    const recorded = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })));
    const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
    if (card?.type === "secret_request" && card.secretStatus !== "saved") {
      yield* removeAnswered(input.threadId, item);
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
  }, answerLock.withPermits(1));

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = yield* refFor(input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const writeSecretFile = (dir: string, file: string, value: string) => {
    const partial = `${file}.partial`;
    return fileSystem.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(dir, 0o700)),
      Effect.andThen(fileSystem.remove(partial, { force: true })),
      // `wx` never follows or replaces an existing path.
      Effect.andThen(
        fileSystem.writeFile(partial, new TextEncoder().encode(value), {
          flag: "wx",
          mode: 0o600,
        }),
      ),
      Effect.andThen(fileSystem.rename(partial, file)),
      Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
    );
  };

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const projectId = records.thread.projectId;
    const deliver = Effect.fn("SecretRequests.deliverFile")(function* (field: FieldName) {
      const ref = yield* refFor(input.threadId, item.id, field);
      const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* readRef({ ref, projectId });
      yield* writeSecretFile(filesDir, file, value);
      return yield* removeStored;
    });
    const { fields } = item;
    return yield* Effect.gen(function* () {
      if (fields === undefined) return { file: yield* deliver(undefined) };
      const files: Record<string, string> = {};
      for (const field of fields) files[field.name] = yield* deliver(field.name);
      return { files };
    }).pipe(consumeLock.withPermits(1));
  });

  const savePasted: SecretRequests["Service"]["savePasted"] = Effect.fn(
    "SecretRequests.savePasted",
  )(function* (input) {
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = yield* refFor(
      input.threadId,
      `pasted\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    // A retry with the same clientRequestId gets the file the first call wrote, unchanged, so a
    // command already holding that path never reads another value.
    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
      yield* writeSecretFile(filesDir, file, input.value);
      return file;
    }).pipe(consumeLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, consume, saveToFile, savePasted });
});

export const layer = Layer.effect(SecretRequests, make);
