/**
 * SecretRequests - secrets an agent asks the user for.
 *
 * The user's answer goes straight to the server's secret store under a
 * one-use SecretRef; orchestration only records the request and its status.
 * A tool that needs the value takes the ref and consumes it, so the value
 * never reaches the transcript, projections, clients, or model context.
 *
 * @module SecretRequests
 */
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  type SecretRequestFailureReason,
  type ProjectId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
/** Store name for a ref's value; refs are fixed-length hex, so names stay short and safe. */
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
/** A value nobody used within this long is dropped; the agent can ask again. */
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;

/**
 * Each request has exactly one ref, derived from where it was asked. Its
 * length never depends on the thread id, so the store's file names stay
 * within filesystem limits, and the requesting tool finds it without a
 * second record. Unguessable without the server's own salt.
 */
const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

/** A ref's value, the project it was entered for, and when it was saved. */
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

const fail = (reason: SecretRequestFailureReason, cause?: unknown) =>
  new SecretRequestError({ reason, ...(cause === undefined ? {} : { cause }) });

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    /**
     * Answers a pending request in a thread. Saving stores the value under a
     * new ref that the requesting tool reads from the request's status.
     */
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    /** The ref minted when this request was saved, for the tool that asked. */
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    /**
     * Reads and deletes a ref's value. Fails for unknown or used refs, and
     * for refs entered in another project.
     */
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const answer: SecretRequests["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => fail("load_failed", cause)));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* fail("not_found");
      }
      if (item.secretStatus !== "pending") {
        return yield* fail("already_answered");
      }
      // The agent is waiting inside the run that asked; once it has ended,
      // nobody will ever receive the ref, so a value saved now would be lost.
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* fail("agent_stopped");
      }
      // Store first: the card only says saved once the value is kept. Create,
      // not set: a second answer racing this one must not replace the value.
      if (input.answer.type === "save") {
        const encoded = yield* encodeStored({
          projectId: records.thread.projectId,
          value: input.answer.secret,
          savedAt: yield* Clock.currentTimeMillis,
        }).pipe(Effect.orDie);
        yield* store
          .create(
            storeName(refFor(salt, input.threadId, item.id)),
            new TextEncoder().encode(encoded),
          )
          .pipe(
            Effect.mapError((error) =>
              ServerSecretStore.isSecretAlreadyExistsError(error)
                ? fail("already_answered", error)
                : fail("store_failed", error),
            ),
          );
      }
      const secretStatus = input.answer.type === "save" ? "saved" : "declined";
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
          secretStatus,
        })
        .pipe(Effect.mapError((cause) => fail("record_failed", cause)));
    }).pipe(Effect.withSpan("SecretRequests.answer"));

  const savedRef: SecretRequests["Service"]["savedRef"] = (input) =>
    Effect.gen(function* () {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    });

  /** Removes a stored value; a failure is logged, since the value is still on disk. */
  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // get and remove are separate store calls; one consumer at a time keeps two
  // concurrent calls from both reading a ref before either deletes it.
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

  const consumeRef = (input: { readonly ref: SecretRef; readonly projectId: ProjectId }) =>
    Effect.gen(function* () {
      if (!REF_PATTERN.test(input.ref)) return yield* fail("invalid_ref");
      const stored = yield* store
        .get(storeName(input.ref))
        .pipe(Effect.mapError((cause) => fail("read_failed", cause)));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
        return yield* fail("ref_unavailable");
      }
      if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
        // The hourly sweep retries a removal that fails here.
        yield* removeLogged(storeName(input.ref));
        return yield* fail("ref_expired");
      }
      // One use: the value moves into whatever consumed it. If it cannot be
      // deleted, it is not handed out, so a ref is never used twice.
      if (!(yield* removeLogged(storeName(input.ref)))) {
        return yield* fail("consume_failed");
      }
      return decoded.value.value;
    });

  /**
   * Drops values nobody used before they expired, so an agent that never
   * consumed its ref does not leave the user's secret on disk.
   */
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
  // Once at startup, then hourly; a value lingers at most an hour past expiry.
  yield* sweepExpired;
  yield* sweepExpired.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, consume });
});

export const layer = Layer.effect(SecretRequests, make);
