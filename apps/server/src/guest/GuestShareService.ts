import {
  type ChatAttachment,
  ChatAttachmentId,
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
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GetTurnItemResult,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  threadHtmlRenderAttachmentIds,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import { GUEST_FAILURE } from "../orchestration-v2/GuestShareDecider.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { coalesceThreadLiveStream } from "../orchestration-v2/ThreadLiveEventCoalescer.ts";
import { buildBoundedThreadStreamSnapshot } from "../orchestration-v2/ThreadStream.ts";
import {
  projectDomainEventForWire,
  projectTurnItemForDetail,
} from "../orchestration-v2/WireProjection.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { guestShareView, guestThreadModel } from "./guestView.ts";
import {
  classifyGuestUploads,
  GUEST_UPLOAD_HEADER_BYTES,
  type GuestUpload,
} from "./guestAttachments.ts";

const SIGNING_SECRET_NAME = "guest-share-signing-key";
const SHARE_ID_BYTES = 16;
const INVITE_SIGNATURE_BYTES = 16;
const SNAPSHOT_ROW_LIMIT = 600;
const SNAPSHOT_USER_TURN_LIMIT = 20;
// How soon an open read notices that its link stopped working, such as Connect no longer serving
// the host. Closing or replacing the link ends the main stream at once.
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);

const GUEST_ACCESS_MESSAGES = {
  ...GUEST_FAILURE,
  invalid: "This guest link is not valid.",
  stale_page: "This page is for an older guest link. Reload it to continue.",
  unavailable: "This item is not available.",
  rejected: "The owner's server rejected this request.",
  empty: "Write a message or attach a file.",
  too_many_files: "Attach up to 4 files to a message.",
  too_large: "Attached files can total up to 10 MB per message.",
  unsupported_file: "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP.",
  files_busy: GUEST_FAILURE.filesBusy,
} as const;

/** What a guest is told. The message comes from `reason`, never from a cause. */
export class GuestShareAccessError extends Schema.TaggedError<GuestShareAccessError>()(
  "GuestShareAccessError",
  {
    reason: Schema.Literals([
      "invalid",
      "inactive",
      "used",
      "busy",
      "stale_page",
      "unavailable",
      "rejected",
      "empty",
      "too_many_files",
      "too_large",
      "unsupported_file",
      "files_busy",
    ]),
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
        : cause === GUEST_FAILURE.filesBusy
          ? "files_busy"
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
    /** Stores the guest's files as the thread's attachments and records the message with them. */
    readonly submit: (
      session: string,
      request: GuestSubmitRequest,
      uploads: ReadonlyArray<GuestUpload>,
    ) => Effect.Effect<void, GuestShareAccessError>;
    readonly stream: (
      session: string,
    ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestShareAccessError>;
    /** The file of an HTML render in the shared thread, and its title. */
    readonly render: (
      session: string,
      itemId: string,
    ) => Effect.Effect<{ readonly path: string; readonly title: string }, GuestShareAccessError>;
    /** One item of the shared thread, as the owner's expanded row loads it. */
    readonly item: (
      session: string,
      itemId: string,
    ) => Effect.Effect<OrchestrationV2GetTurnItemResult, GuestShareAccessError>;
    /** A command's output frames, as the owner's expanded row gets them, until the link ends. */
    readonly commandOutput: (
      session: string,
      itemId: string,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2CommandOutputFrame>, GuestShareAccessError>;
    /** A file in the shared thread or one of the share's messages, never a dismissed one's. */
    readonly attachment: (
      session: string,
      attachmentId: string,
    ) => Effect.Effect<
      { readonly path: string; readonly attachment: ChatAttachment },
      GuestShareAccessError
    >;
  }
>()("t3/guest/GuestShareService") {}

/** The thread record an event carries, for the share and the view. */
const threadOf = (event: OrchestrationV2DomainEvent): OrchestrationV2AppThread | null => {
  switch (event.type) {
    case "thread.guest-share-updated":
    case "thread.metadata-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return event.payload;
    default:
      return null;
  }
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const commandOutputs = yield* CommandOutputHub.CommandOutputHub;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
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
  // A beta: while it is off, no link opens and every guest request is refused.
  const sharingEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.guestSharingEnabled),
    Effect.orElseSucceed(() => false),
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
      !(yield* sharingEnabled) ||
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
    if (!(yield* sharingEnabled)) {
      return yield* new GuestShareCreateError({ reason: "disabled" });
    }
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

  const uploadFailed = new GuestShareAccessError({ reason: "rejected" });
  const removeStored = (attachments: ReadonlyArray<ChatAttachment>) =>
    Effect.forEach(
      attachments,
      (attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        return path === null
          ? Effect.void
          : fileSystem.remove(path, { force: true }).pipe(Effect.ignore);
      },
      { discard: true },
    );

  /**
   * Checks the files and stores them as the thread's attachments, so a message can wait longer
   * than the day the pending-upload sweep allows. Send uses them as they are; dismissing the
   * message or ending the share deletes them.
   */
  const storeUploads = Effect.fn("GuestShareService.storeUploads")(function* (
    threadId: ThreadId,
    uploads: ReadonlyArray<GuestUpload>,
  ) {
    const inspected = yield* Effect.forEach(uploads, (upload) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(upload.path);
        const file = yield* fileSystem.open(upload.path, { flag: "r" });
        const header = Option.getOrElse(
          yield* file.readAlloc(GUEST_UPLOAD_HEADER_BYTES),
          () => new Uint8Array(),
        );
        return { ...upload, sizeBytes: Number(info.size), header };
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => uploadFailed),
      ),
    );
    const classified = classifyGuestUploads(inspected);
    if (!classified.ok) return yield* new GuestShareAccessError({ reason: classified.reason });
    const stored: Array<ChatAttachment> = [];
    yield* Effect.forEach(
      classified.attachments,
      (draft, index) =>
        Effect.gen(function* () {
          const id = createAttachmentId(
            threadId,
            draft.type === "file" ? attachmentFileExtension(draft.name) : undefined,
          );
          if (id === null) return yield* uploadFailed;
          const attachment: ChatAttachment = { ...draft, id: ChatAttachmentId.make(id) };
          const path = resolveAttachmentPath({ attachmentsDir, attachment });
          if (path === null) return yield* uploadFailed;
          yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
          yield* fileSystem.copyFile(uploads[index]!.path, path);
          stored.push(attachment);
        }).pipe(Effect.mapError(() => uploadFailed)),
      { discard: true },
    ).pipe(Effect.onError(() => removeStored(stored)));
    return stored;
  });

  const submit = Effect.fn("GuestShareService.submit")(function* (
    session: string,
    request: GuestSubmitRequest,
    uploads: ReadonlyArray<GuestUpload>,
  ) {
    const { thread, share } = yield* authorize(session, "session");
    if (request.shareId !== share.id) {
      return yield* new GuestShareAccessError({ reason: "stale_page" });
    }
    if (request.text === "" && uploads.length === 0) {
      return yield* new GuestShareAccessError({ reason: "empty" });
    }
    const attachments = yield* storeUploads(thread.id, uploads);
    yield* dispatchGuestCommand({
      type: "thread.guest-message.submit",
      commandId: yield* commandId("submit"),
      threadId: thread.id,
      shareId: share.id,
      guestMessageId: GuestMessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      text: request.text,
      ...(attachments.length === 0 ? {} : { attachments }),
    }).pipe(Effect.onError(() => removeStored(attachments)));
  });

  /** Completes once the session no longer opens its share, so open reads end with it. */
  const untilRevoked = (session: string) =>
    authorize(session, "session").pipe(
      Effect.repeat(Schedule.spaced(ACCESS_RECHECK_INTERVAL)),
      Effect.ignore,
    );

  /**
   * The thread as the owner's thread subscription sends it: a bounded snapshot, then the same
   * wire events, batched the same way. Only the share's own state is added.
   */
  const stream = Effect.fn("GuestShareService.stream")(function* (session: string) {
    const { thread, share } = yield* authorize(session, "session");
    const snapshot = yield* orchestrator
      .getThreadSnapshotWindow(thread.id, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
      })
      .pipe(Effect.mapError(() => inactive));
    // The share can end between authorize and this read; the live tail starts after it.
    if (
      snapshot.projection.thread.guestShare?.id !== share.id ||
      snapshot.projection.thread.archivedAt !== null ||
      snapshot.projection.thread.deletedAt !== null
    ) {
      return yield* inactive;
    }
    // Read once; a provider configured mid-share shows after the guest reconnects.
    const providers = yield* providerRegistry.getProviders;
    const viewOf = (current: OrchestrationV2AppThread) =>
      guestShareView(current, guestThreadModel(current.modelSelection, providers));
    const initialView = viewOf(snapshot.projection.thread);
    if (initialView === null) return yield* inactive;

    const ended: GuestStreamEvent = { type: "ended" };
    const endsShare = (event: OrchestrationV2DomainEvent) => {
      if (event.type === "thread.archived" || event.type === "thread.deleted") return true;
      const updated = threadOf(event);
      return updated !== null && updated.guestShare?.id !== share.id;
    };
    const live = orchestrator
      .streamStoredEventsFrom({ threadId: thread.id, afterSequence: snapshot.snapshotSequence })
      .pipe(
        Stream.map((stored) => ({
          kind: "event" as const,
          sequence: stored.sequence,
          event: projectDomainEventForWire(stored.event),
        })),
        // Ending the source here flushes what the coalescer holds, so `ended` is not held back.
        Stream.takeUntil((item) => endsShare(item.event)),
        coalesceThreadLiveStream,
        Stream.map((item): ReadonlyArray<GuestStreamEvent> => {
          if (item.kind !== "event") return [];
          if (endsShare(item.event)) return [ended];
          const updated = threadOf(item.event);
          const view = updated === null ? null : viewOf(updated);
          return view === null
            ? [{ type: "thread", item }]
            : [
                { type: "thread", item },
                { type: "view", view },
              ];
        }),
        Stream.flattenIterable,
        // A failed read closes the response without `ended`: the browser reconnects, and
        // `authorize` decides whether the link still works.
        Stream.catchCause(() => Stream.empty),
      );
    const untilExpiry = Effect.sleep(
      Math.max(0, Date.parse(share.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)),
    );
    const opening: ReadonlyArray<GuestStreamEvent> = [
      { type: "view", view: initialView },
      {
        type: "thread",
        item: buildBoundedThreadStreamSnapshot({
          snapshotSequence: snapshot.snapshotSequence,
          projection: snapshot.projection,
        }),
      },
    ];
    return Stream.fromIterable(opening).pipe(
      Stream.concat(
        Stream.merge(live, Stream.fromEffect(Effect.as(untilExpiry, ended)), {
          haltStrategy: "either",
        }),
      ),
      Stream.takeUntil((event) => event.type === "ended"),
      // Unlinking T3 Connect closes it quietly, so a tunnel that comes back on the same host
      // keeps the guest in. Turning the beta off closes it the same way. Closing and expiry end
      // it above, with `ended`.
      Stream.interruptWhen(
        Effect.all([connectHostname, sharingEnabled]).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(ACCESS_RECHECK_INTERVAL),
            until: ([host, enabled]) => host !== share.host || !enabled,
          }),
        ),
      ),
    );
  });

  const unavailable = new GuestShareAccessError({ reason: "unavailable" });

  /** An item of the shared thread, read after the session check. */
  const threadItem = Effect.fn("GuestShareService.threadItem")(function* (
    session: string,
    itemId: string,
  ) {
    const { thread } = yield* authorize(session, "session");
    const item = yield* orchestrator
      .getTurnItem({ threadId: thread.id, itemId: TurnItemId.make(itemId) })
      .pipe(Effect.mapError(() => unavailable));
    return item === null ? yield* unavailable : { thread, item };
  });

  const render = Effect.fn("GuestShareService.render")(function* (session: string, itemId: string) {
    const { thread, item } = yield* threadItem(session, itemId);
    if (item.type !== "dynamic_tool") return yield* unavailable;
    const reference = htmlRenderFromToolItem(item);
    const [attachmentId] = threadHtmlRenderAttachmentIds(thread.id, [item]);
    const path =
      attachmentId === undefined
        ? null
        : resolveAttachmentPathById({ attachmentsDir, attachmentId });
    if (reference === undefined || path === null) return yield* unavailable;
    return { path, title: reference.title };
  });

  const item = Effect.fn("GuestShareService.item")(function* (session: string, itemId: string) {
    const { item } = yield* threadItem(session, itemId);
    return { item: projectTurnItemForDetail(item) };
  });

  const commandOutput = Effect.fn("GuestShareService.commandOutput")(function* (
    session: string,
    itemId: string,
  ) {
    const { thread, item } = yield* threadItem(session, itemId);
    if (item.type !== "command_execution") return yield* unavailable;
    return commandOutputs.subscribe({ threadId: thread.id, itemId: item.id }).pipe(
      // A lost hub stream ends the output; the row reloads it when reopened.
      Stream.catchCause(() => Stream.empty),
      Stream.interruptWhen(untilRevoked(session)),
    );
  });

  const attachment = Effect.fn("GuestShareService.attachment")(function* (
    session: string,
    attachmentId: string,
  ) {
    const { thread, share } = yield* authorize(session, "session");
    // A dismissed message's files are deleted with it.
    const fromShare = share.messages
      .flatMap((message) => (message.status === "dismissed" ? [] : (message.attachments ?? [])))
      .find((candidate) => candidate.id === attachmentId);
    const found =
      fromShare ??
      (yield* orchestrator.getThreadRecords(thread.id, ["messages"]).pipe(
        Effect.map(({ messages }) =>
          messages
            .flatMap((message) => message.attachments ?? [])
            .find((candidate) => candidate.id === attachmentId),
        ),
        Effect.mapError(() => unavailable),
      ));
    const path =
      found === undefined ? null : resolveAttachmentPath({ attachmentsDir, attachment: found });
    if (found === undefined || path === null) return yield* unavailable;
    const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    return exists ? { path, attachment: found } : yield* unavailable;
  });

  return GuestShareService.of({
    create,
    redeem,
    check,
    submit,
    stream,
    render,
    item,
    commandOutput,
    attachment,
  });
});

export const layer = Layer.effect(GuestShareService, make);
