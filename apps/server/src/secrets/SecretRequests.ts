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
  type ProjectId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
/** Store name for a ref's value; refs are random hex, so they are safe as names. */
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;

/** A ref's value plus the project it was entered for, stored together. */
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

const fail = (message: string) => new SecretRequestError({ message });

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
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  /** Which ref each saved request minted; the store holds the value itself. */
  const refForRequest = (threadId: ThreadId, turnItemId: string) =>
    `secret-request-ref-${Buffer.from(`${threadId}\u0000${turnItemId}`).toString("base64url")}`;

  const newRef = crypto.randomBytes(16).pipe(
    Effect.map((bytes) =>
      SecretRef.make(`${SECRET_REF_PREFIX}${Buffer.from(bytes).toString("hex")}`),
    ),
    Effect.orDie,
  );

  const answer: SecretRequests["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(() => fail("Could not load the secret request.")));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* fail("This secret request no longer exists.");
      }
      if (item.secretStatus !== "pending") {
        return yield* fail("This secret request was already answered.");
      }
      // Store first: the card only says saved once the value is kept.
      if (input.answer.type === "save") {
        const ref = yield* newRef;
        const encoded = yield* encodeStored({
          projectId: records.thread.projectId,
          value: input.answer.secret,
        }).pipe(Effect.orDie);
        yield* Effect.all([
          store.set(storeName(ref), new TextEncoder().encode(encoded)),
          store.set(refForRequest(input.threadId, item.id), new TextEncoder().encode(ref)),
        ]).pipe(Effect.mapError(() => fail("Could not store the secret.")));
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
        .pipe(Effect.mapError(() => fail("Saved the secret, but could not update the request.")));
    });

  const savedRef: SecretRequests["Service"]["savedRef"] = (input) =>
    store.get(refForRequest(input.threadId, input.turnItemId)).pipe(
      Effect.map(Option.map((bytes) => SecretRef.make(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none()),
    );

  const consume: SecretRequests["Service"]["consume"] = (input) =>
    Effect.gen(function* () {
      if (!REF_PATTERN.test(input.ref)) return yield* fail("That secretRef is not valid.");
      const stored = yield* store
        .get(storeName(input.ref))
        .pipe(Effect.mapError(() => fail("Could not read the secret.")));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
        return yield* fail(
          "That secretRef was already used or does not exist. Ask the user again with request_secret.",
        );
      }
      // One use: the value moves into whatever consumed it.
      yield* store.remove(storeName(input.ref)).pipe(Effect.ignore);
      return decoded.value.value;
    });

  return SecretRequests.of({ answer, savedRef, consume });
});

export const layer = Layer.effect(SecretRequests, make);
