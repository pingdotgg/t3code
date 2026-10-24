import {
  CommandId,
  GUEST_SHARE_TTL_MS,
  GuestMessageId,
  GuestShareCreateError,
  type GuestShareCreateInput,
  type GuestShareCreateResult,
  GuestShareId,
  type GuestRedeemRequest,
  type GuestStreamEvent,
  type GuestSubmitRequest,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { GUEST_FAILURE } from "../orchestration-v2/GuestShareDecider.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  guestItemEvent,
  guestItemText,
  guestShareView,
  guestTranscriptItem,
  isGuestVisibleRun,
} from "./guestTranscript.ts";

const SIGNING_SECRET_NAME = "guest-share-signing-key";
const SHARE_ID_BYTES = 16;
const INVITE_SIGNATURE_BYTES = 16;
const SNAPSHOT_ROW_LIMIT = 600;
const HOST_RECHECK_INTERVAL = Duration.seconds(30);
const SNAPSHOT_USER_TURN_LIMIT = 20;
const WORKING_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const GUEST_ACCESS_MESSAGES = {
  ...GUEST_FAILURE,
  invalid: "This guest link is not valid.",
  stale_page: "This page is for an older guest link. Reload it to continue.",
  rejected: "The owner's server rejected this request.",
} as const;

/** What a guest is told. The message comes from `reason`, never from a cause. */
export class GuestShareAccessError extends Schema.TaggedError<GuestShareAccessError>()(
  "GuestShareAccessError",
  {
    reason: Schema.Literals(["invalid", "inactive", "used", "busy", "stale_page", "rejected"]),
  },
) {
  override get message(): string {
    return GUEST_ACCESS_MESSAGES[this.reason];
  }
}

const guestFailureReason = (cause: unknown): GuestShareAccessError["reason"] =>
  cause === GUEST_FAILURE.inactive
    ? "inactive"
    : cause === GUEST_FAILURE.used
      ? "used"
      : cause === GUEST_FAILURE.busy
        ? "busy"
        : "rejected";

const SessionClaims = Schema.Struct({
  kind: Schema.Literal("session"),
  threadId: ThreadId,
  shareId: GuestShareId,
});
type SessionClaims = typeof SessionClaims.Type;
const decodeSessionClaims = Schema.decodeUnknownOption(Schema.fromJsonString(SessionClaims));

/** A truncated HMAC keeps invite links short. 128 bits is still far beyond guessing range. */
const inviteSignature = (shareId: string, key: Uint8Array) =>
  base64UrlEncode(
    Buffer.from(signPayload(`guest-invite:${shareId}`, key), "base64url").subarray(
      0,
      INVITE_SIGNATURE_BYTES,
    ),
  );

const inactive = new GuestShareAccessError({ reason: "inactive" });

export class GuestShareService extends Context.Service<
  GuestShareService,
  {
    readonly create: (
      input: GuestShareCreateInput,
    ) => Effect.Effect<GuestShareCreateResult, GuestShareCreateError>;
    /** Spends an invite and returns the session token for the guest's cookie. */
    readonly redeem: (
      request: GuestRedeemRequest,
    ) => Effect.Effect<
      { readonly token: string; readonly shareId: GuestShareId },
      GuestShareAccessError
    >;
    /** Succeeds while the session can still open its share. */
    readonly check: (session: string) => Effect.Effect<void, GuestShareAccessError>;
    readonly submit: (
      session: string,
      request: GuestSubmitRequest,
    ) => Effect.Effect<void, GuestShareAccessError>;
    readonly stream: (
      session: string,
    ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestShareAccessError>;
  }
>()("t3/guest/GuestShareService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingKey = yield* Effect.cached(
    secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );

  // Tokens are derived from the share id, so nothing secret is stored and replacing or closing
  // the share in the thread projection revokes every token for it. An invite is
  // `<shareId>.<signature>` and the thread is looked up by share id; a session token carries
  // signed claims.
  const signInvite = (shareId: GuestShareId) =>
    Effect.map(signingKey, (key) => `${shareId}.${inviteSignature(shareId, key)}`);
  const signSession = (claims: SessionClaims) =>
    Effect.map(signingKey, (key) => {
      const payload = base64UrlEncode(JSON.stringify(claims));
      return `${payload}.${signPayload(payload, key)}`;
    });
  const splitToken = (token: string) => {
    const [payload, signature, extra] = token.split(".");
    return payload && signature && extra === undefined ? { payload, signature } : null;
  };
  const verifyInvite = Effect.fn("GuestShareService.verifyInvite")(function* (token: string) {
    const parts = splitToken(token);
    if (parts === null) return Option.none<SessionClaims>();
    const key = yield* signingKey;
    if (!timingSafeEqualBase64Url(parts.signature, inviteSignature(parts.payload, key))) {
      return Option.none<SessionClaims>();
    }
    const shareId = GuestShareId.make(parts.payload);
    const threadId = yield* orchestrator
      .findGuestShareThreadId(shareId)
      .pipe(Effect.mapError(() => inactive));
    return threadId === null
      ? Option.none<SessionClaims>()
      : Option.some<SessionClaims>({ kind: "session", threadId, shareId });
  });
  const verifySession = (token: string) =>
    Effect.map(signingKey, (key) => {
      const parts = splitToken(token);
      if (parts === null) return Option.none<SessionClaims>();
      if (!timingSafeEqualBase64Url(parts.signature, signPayload(parts.payload, key))) {
        return Option.none<SessionClaims>();
      }
      return decodeSessionClaims(base64UrlDecodeUtf8(parts.payload));
    });

  const connectHostname = managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? null),
  );

  const dispatchGuestCommand = (
    command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
  ) =>
    orchestrator.dispatch(command).pipe(
      Effect.mapError(
        (error) =>
          new GuestShareAccessError({
            reason: guestFailureReason("cause" in error ? error.cause : undefined),
          }),
      ),
    );

  const commandId = (label: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => CommandId.make(`server:guest-share:${label}:${uuid}`)),
      Effect.orDie,
    );

  /** Checks a token against the live share: same id, not expired, and Connect still serving it. */
  const authorize = Effect.fn("GuestShareService.authorize")(function* (
    token: string,
    kind: "invite" | "session",
  ) {
    const claims = yield* kind === "invite" ? verifyInvite(token) : verifySession(token);
    if (Option.isNone(claims)) {
      return yield* new GuestShareAccessError({ reason: "invalid" });
    }
    const { thread } = yield* orchestrator
      .getThreadRecords(claims.value.threadId, [])
      .pipe(Effect.mapError(() => inactive));
    const share = thread.guestShare;
    const now = yield* DateTime.now;
    if (
      !share ||
      share.id !== claims.value.shareId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      DateTime.toEpochMillis(now) >= Date.parse(share.expiresAt) ||
      (kind === "session" && share.guestName === null) ||
      (yield* connectHostname) !== share.host
    ) {
      return yield* inactive;
    }
    return { thread, share };
  });

  const create = Effect.fn("GuestShareService.create")(function* (input: GuestShareCreateInput) {
    const host = yield* connectHostname;
    if (host === null) {
      return yield* new GuestShareCreateError({ reason: "connect_unavailable" });
    }
    const shareId = GuestShareId.make(
      base64UrlEncode(yield* crypto.randomBytes(SHARE_ID_BYTES).pipe(Effect.orDie)),
    );
    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(DateTime.add(now, { milliseconds: GUEST_SHARE_TTL_MS }));
    yield* orchestrator
      .dispatch({
        type: "thread.guest-share.open",
        commandId: yield* commandId("open"),
        threadId: input.threadId,
        shareId,
        host,
        expiresAt,
      })
      .pipe(Effect.mapError(() => new GuestShareCreateError({ reason: "thread_unavailable" })));
    const { thread } = yield* orchestrator
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(() => new GuestShareCreateError({ reason: "read_failed" })));
    if (!thread.guestShare || thread.guestShare.id !== shareId) {
      return yield* new GuestShareCreateError({ reason: "changed" });
    }
    const credential = yield* signInvite(shareId);
    return { url: `https://${host}/guest#${credential}`, share: thread.guestShare };
  });

  const redeem = Effect.fn("GuestShareService.redeem")(function* (request: GuestRedeemRequest) {
    const { thread, share } = yield* authorize(request.credential, "invite");
    yield* dispatchGuestCommand({
      type: "thread.guest-share.redeem",
      commandId: yield* commandId("redeem"),
      threadId: thread.id,
      shareId: share.id,
      guestName: request.name,
    });
    const token = yield* signSession({ kind: "session", threadId: thread.id, shareId: share.id });
    return { token, shareId: share.id };
  });

  const check = Effect.fn("GuestShareService.check")(function* (session: string) {
    yield* authorize(session, "session");
  });

  const submit = Effect.fn("GuestShareService.submit")(function* (
    session: string,
    request: GuestSubmitRequest,
  ) {
    const { thread, share } = yield* authorize(session, "session");
    if (request.shareId !== share.id) {
      return yield* new GuestShareAccessError({ reason: "stale_page" });
    }
    yield* dispatchGuestCommand({
      type: "thread.guest-message.submit",
      commandId: yield* commandId("submit"),
      threadId: thread.id,
      shareId: share.id,
      guestMessageId: GuestMessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      text: request.text,
    });
  });

  const stream = Effect.fn("GuestShareService.stream")(function* (session: string) {
    const { thread: authorizedThread, share } = yield* authorize(session, "session");
    const snapshot = yield* orchestrator
      .getThreadSnapshotWindow(authorizedThread.id, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
      })
      .pipe(Effect.mapError(() => inactive));
    const { projection } = snapshot;
    // The thread can change between authorize and this read; the live tail starts after it.
    if (
      projection.thread.guestShare?.id !== share.id ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    ) {
      return yield* inactive;
    }

    const runStatuses = new Map<RunId, OrchestrationV2Run["status"]>();
    for (const run of projection.runs) {
      if (isGuestVisibleRun(run, share.historyStartRunOrdinal)) runStatuses.set(run.id, run.status);
    }
    const texts = new Map<string, string>();
    const items = projection.visibleTurnItems.flatMap((entry) => {
      if (entry.visibility !== "local" || entry.item.runId === null) return [];
      if (!runStatuses.has(entry.item.runId)) return [];
      const item = guestTranscriptItem(entry.item);
      if (item === null) return [];
      const text = guestItemText(item);
      if (text !== undefined) texts.set(item.id, text);
      return [item];
    });
    const working = () =>
      [...runStatuses.values()].some((status) => WORKING_RUN_STATUSES.has(status));
    let thread: OrchestrationV2AppThread = projection.thread;
    const view = () => guestShareView(thread, working());
    const initialView = view();
    if (initialView === null) return yield* inactive;

    const ended: GuestStreamEvent = { type: "ended" };
    const live = orchestrator
      .streamStoredEventsFrom({ threadId: thread.id, afterSequence: snapshot.snapshotSequence })
      .pipe(
        Stream.map((stored): ReadonlyArray<GuestStreamEvent> => {
          const event = stored.event;
          switch (event.type) {
            case "run.created":
            case "run.updated": {
              if (!isGuestVisibleRun(event.payload, share.historyStartRunOrdinal)) return [];
              const wasWorking = working();
              runStatuses.set(event.payload.id, event.payload.status);
              const next = view();
              return wasWorking === working() || next === null
                ? []
                : [{ type: "view", view: next }];
            }
            case "turn-item.updated": {
              const runId = event.payload.runId;
              if (runId === null || !runStatuses.has(runId)) return [];
              const item = guestTranscriptItem(event.payload);
              if (item === null) return [];
              const update = guestItemEvent(texts.get(item.id), item);
              const text = guestItemText(item);
              if (text !== undefined) texts.set(item.id, text);
              return [update];
            }
            case "thread.archived":
            case "thread.deleted":
              return [ended];
            case "thread.guest-share-updated":
            case "thread.metadata-updated": {
              thread = event.payload;
              if (thread.guestShare?.id !== share.id) return [ended];
              const next = view();
              return next === null ? [ended] : [{ type: "view", view: next }];
            }
            default:
              return [];
          }
        }),
        Stream.flattenIterable,
        Stream.takeUntil((event) => event.type === "ended"),
        Stream.catchCause(() => Stream.make(ended)),
      );
    const untilExpiry = Effect.sleep(
      Math.max(0, Date.parse(share.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)),
    );
    // Unlinking T3 Connect must also end streams that are already open.
    const untilHostLost = connectHostname.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(HOST_RECHECK_INTERVAL),
        until: (current) => current !== share.host,
      }),
    );
    const snapshotEvent: GuestStreamEvent = { type: "snapshot", view: initialView, items };
    return Stream.concat(
      Stream.make(snapshotEvent),
      Stream.concat(
        live.pipe(Stream.interruptWhen(Effect.race(untilExpiry, untilHostLost))),
        Stream.make(ended),
      ),
    ).pipe(Stream.takeUntil((event) => event.type === "ended"));
  });

  return GuestShareService.of({ create, redeem, check, submit, stream });
});

export const layer = Layer.effect(GuestShareService, make);
