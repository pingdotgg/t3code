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
  type GuestTurnItemDetail,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type RunId,
  ThreadId,
  type OrchestrationV2Run,
  type GuestTurnItem,
  type ThreadGuestShare,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  createPendingAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  threadHtmlRenderAttachmentIds,
} from "../attachmentStore.ts";
import { sweepPendingAttachmentsOccasionally } from "../assets/AttachmentUpload.ts";
import * as ServerConfig from "../config.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import { GUEST_FAILURE } from "../orchestration-v2/GuestShareDecider.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  coalesceGuestEvents,
  guestCommandOutputFrames,
  guestPathRoots,
  guestShareView,
  guestThreadModel,
  isGuestVisibleRun,
  guestRunTurnEnded,
  projectRunForGuest,
  projectSnapshotForGuest,
  projectTurnItemForGuest,
  projectTurnItemForGuestDetail,
} from "./guestProjection.ts";
import {
  classifyGuestUploads,
  GUEST_UPLOAD_HEADER_BYTES,
  type GuestUpload,
} from "./guestAttachments.ts";

const SIGNING_SECRET_NAME = "guest-share-signing-key";
const SHARE_ID_BYTES = 16;
const INVITE_SIGNATURE_BYTES = 16;
const SNAPSHOT_ROW_LIMIT = 600;
const HOST_RECHECK_INTERVAL = Duration.seconds(30);
const SNAPSHOT_USER_TURN_LIMIT = 20;
const GUEST_COMMAND_OUTPUT_BYTES_PER_SECOND = 128 * 1024;
// Streaming text and running tools update many times a second; the owner's stream batches the
// same way (see ThreadLiveEventCoalescer).
const LIVE_COALESCE_WINDOW = Duration.millis(50);
const LIVE_COALESCE_MAX_EVENTS = 512;

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
    /** Stores the guest's files as pending uploads and records the message with them. */
    readonly submit: (
      session: string,
      request: GuestSubmitRequest,
      uploads: ReadonlyArray<GuestUpload>,
    ) => Effect.Effect<void, GuestShareAccessError>;
    readonly stream: (
      session: string,
    ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestShareAccessError>;
    /** The file of an HTML render the guest can see in the transcript, and its title. */
    readonly render: (
      session: string,
      itemId: string,
    ) => Effect.Effect<{ readonly path: string; readonly title: string }, GuestShareAccessError>;
    /** An item the guest can see, as its expanded row shows it. */
    readonly item: (
      session: string,
      itemId: string,
    ) => Effect.Effect<GuestTurnItemDetail, GuestShareAccessError>;
    /**
     * Output frames of a command the guest can see, as the owner's expanded row gets them, until
     * the command settles or the share ends.
     */
    readonly commandOutput: (
      session: string,
      itemId: string,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2CommandOutputFrame>, GuestShareAccessError>;
    /**
     * A file the guest attached, while its message waits or after it was sent. Never another
     * share's files or the owner's.
     */
    readonly attachment: (
      session: string,
      attachmentId: string,
    ) => Effect.Effect<
      { readonly path: string; readonly attachment: ChatAttachment },
      GuestShareAccessError
    >;
  }
>()("t3/guest/GuestShareService") {}

/**
 * A guest's files show only on messages sent through their own link, as recorded when the owner
 * sent it. A replacement link can still show an earlier guest's messages from the history window,
 * but never their files, in the stream, the item detail, or the file route.
 */
const isOwnGuestMessage = (domain: OrchestrationV2TurnItem, shareId: GuestShareId) =>
  domain.type === "user_message" && domain.context?.guest?.shareId === shareId;

const withOwnGuestFiles = <T extends GuestTurnItem | GuestTurnItemDetail>(
  projected: T,
  domain: OrchestrationV2TurnItem,
  shareId: GuestShareId,
): T =>
  projected.type === "user_message" &&
  projected.attachments.length > 0 &&
  !isOwnGuestMessage(domain, shareId)
    ? { ...projected, attachments: [] }
    : projected;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const commandOutputs = yield* CommandOutputHub.CommandOutputHub;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const home = yield* HostProcess.HomeDirectory;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const { attachmentsDir } = serverConfig;
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
   * Checks the files and copies them into the attachment store as pending uploads, which the
   * owner's Send copies into the thread and the pending sweep removes after a day.
   */
  const storeUploads = Effect.fn("GuestShareService.storeUploads")(function* (
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
    yield* sweepPendingAttachmentsOccasionally.pipe(
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
    );
    const stored: Array<ChatAttachment> = [];
    yield* Effect.forEach(
      classified.attachments,
      (draft, index) =>
        Effect.gen(function* () {
          const attachment: ChatAttachment = {
            ...draft,
            id: ChatAttachmentId.make(
              createPendingAttachmentId(
                draft.type === "file" ? attachmentFileExtension(draft.name) : undefined,
              ),
            ),
          };
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
    const attachments = yield* storeUploads(uploads);
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

  // Guests get paths relative to the workspace; absolute ones name the owner's home folder.
  const projectRootOf = (thread: OrchestrationV2AppThread) =>
    projects.get(thread.projectId).pipe(
      Effect.map((project) => Option.getOrNull(project)?.workspaceRoot ?? null),
      Effect.orElseSucceed(() => null),
    );

  /** Completes when the share expires or T3 Connect stops serving its host. */
  const untilExpiredOrHostLost = Effect.fn("GuestShareService.untilExpiredOrHostLost")(
    function* (share: { readonly expiresAt: string; readonly host: string }) {
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
      yield* Effect.race(untilExpiry, untilHostLost);
    },
  );

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

    const projectRoot = yield* projectRootOf(projection.thread);
    let thread: OrchestrationV2AppThread = projection.thread;
    let roots = guestPathRoots([thread.worktreePath, projectRoot], home);
    // Read once; a provider configured mid-share shows after the guest reconnects.
    const providers = yield* providerRegistry.getProviders;
    const viewOf = (current: OrchestrationV2AppThread) =>
      guestShareView(current, guestThreadModel(current.modelSelection, providers));
    const domainItems = new Map(
      projection.visibleTurnItems.map((entry) => [entry.item.id, entry.item] as const),
    );
    const guestSnapshot = projectSnapshotForGuest(projection, share.historyStartRunOrdinal, roots);
    const visibleRunIds = new Set<RunId>(guestSnapshot.runs.map((run) => run.id));
    // Kept to re-send a run when its provider turn ends, which arrives as its own event.
    const visibleRuns = new Map(
      projection.runs.filter((run) => visibleRunIds.has(run.id)).map((run) => [run.id, run]),
    );
    const providerTurns = new Map(projection.providerTurns.map((turn) => [turn.id, turn]));
    const guestRun = (run: OrchestrationV2Run): GuestStreamEvent => ({
      type: "run",
      run: projectRunForGuest(run, guestRunTurnEnded(run, providerTurns.values())),
    });
    const initialView = viewOf(thread);
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
              visibleRunIds.add(event.payload.id);
              visibleRuns.set(event.payload.id, event.payload);
              return [guestRun(event.payload)];
            }
            case "provider-turn.updated": {
              providerTurns.set(event.payload.id, event.payload);
              const attemptId = event.payload.runAttemptId;
              const run =
                attemptId === null
                  ? undefined
                  : [...visibleRuns.values()].find(
                      (candidate) => candidate.activeAttemptId === attemptId,
                    );
              return run === undefined ? [] : [guestRun(run)];
            }
            case "turn-item.updated": {
              const runId = event.payload.runId;
              if (runId === null || !visibleRunIds.has(runId)) return [];
              const item = projectTurnItemForGuest(event.payload, roots);
              return item === null
                ? []
                : [{ type: "item", item: withOwnGuestFiles(item, event.payload, share.id) }];
            }
            case "thread.archived":
            case "thread.deleted":
              return [ended];
            case "thread.guest-share-updated":
            case "thread.metadata-updated": {
              thread = event.payload;
              if (thread.guestShare?.id !== share.id) return [ended];
              roots = guestPathRoots([thread.worktreePath, projectRoot], home);
              const next = viewOf(thread);
              return next === null ? [ended] : [{ type: "view", view: next }];
            }
            default:
              return [];
          }
        }),
        Stream.flattenIterable,
        // Ending first means a batch holding `ended` flushes at once instead of after the window.
        Stream.takeUntil((event) => event.type === "ended"),
        Stream.groupedWithin(LIVE_COALESCE_MAX_EVENTS, LIVE_COALESCE_WINDOW),
        Stream.map(coalesceGuestEvents),
        Stream.flattenIterable,
        Stream.catchCause(() => Stream.make(ended)),
      );
    const snapshotEvent: GuestStreamEvent = {
      type: "snapshot",
      view: initialView,
      runs: guestSnapshot.runs,
      items: guestSnapshot.items.map((item) => {
        const domain = domainItems.get(item.id);
        return domain === undefined ? item : withOwnGuestFiles(item, domain, share.id);
      }),
    };
    return Stream.concat(
      Stream.make(snapshotEvent),
      Stream.concat(
        live.pipe(Stream.interruptWhen(untilExpiredOrHostLost(share))),
        Stream.make(ended),
      ),
    ).pipe(Stream.takeUntil((event) => event.type === "ended"));
  });

  const unavailable = new GuestShareAccessError({ reason: "unavailable" });

  /**
   * An item the guest's transcript shows right now: the same snapshot window and visibility rules
   * as the stream, so a rolled-back or out-of-window item is not served.
   */
  const guestSnapshot = Effect.fn("GuestShareService.guestSnapshot")(function* (session: string) {
    const { thread, share } = yield* authorize(session, "session");
    const { projection, snapshotSequence } = yield* orchestrator
      .getThreadSnapshotWindow(thread.id, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
      })
      .pipe(Effect.mapError(() => inactive));
    // The share can end between authorize and this read, as in `stream`.
    if (
      projection.thread.guestShare?.id !== share.id ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null
    ) {
      return yield* inactive;
    }
    const visibleRunIds = new Set(
      projection.runs
        .filter((run) => isGuestVisibleRun(run, share.historyStartRunOrdinal))
        .map((run) => run.id),
    );
    return {
      thread: projection.thread,
      share,
      snapshotSequence,
      visibleItems: projection.visibleTurnItems.flatMap((entry) =>
        entry.visibility === "local" &&
        entry.item.runId !== null &&
        visibleRunIds.has(entry.item.runId)
          ? [entry.item]
          : [],
      ),
    };
  });

  const visibleItem = Effect.fn("GuestShareService.visibleItem")(function* (
    session: string,
    itemId: string,
  ) {
    const { visibleItems, ...snapshot } = yield* guestSnapshot(session);
    const item = visibleItems.find((candidate) => candidate.id === itemId);
    return item === undefined ? yield* unavailable : { ...snapshot, item };
  });

  const render = Effect.fn("GuestShareService.render")(function* (session: string, itemId: string) {
    const { thread, item } = yield* visibleItem(session, itemId);
    // The same policy as the stream decides whether the guest sees this visual.
    const guestItem = projectTurnItemForGuest(item, []);
    if (
      item.type !== "dynamic_tool" ||
      guestItem?.type !== "dynamic_tool" ||
      guestItem.output === undefined
    ) {
      return yield* unavailable;
    }
    const [attachmentId] = threadHtmlRenderAttachmentIds(thread.id, [item]);
    const path =
      attachmentId === undefined
        ? null
        : resolveAttachmentPathById({ attachmentsDir, attachmentId });
    if (path === null) return yield* unavailable;
    return { path, title: guestItem.output.htmlRender.title };
  });

  const item = Effect.fn("GuestShareService.item")(function* (session: string, itemId: string) {
    const { thread, share, item } = yield* visibleItem(session, itemId);
    const roots = guestPathRoots([thread.worktreePath, yield* projectRootOf(thread)], home);
    const detail = projectTurnItemForGuestDetail(item, roots);
    return detail === null ? yield* unavailable : withOwnGuestFiles(detail, item, share.id);
  });

  const commandOutput = Effect.fn("GuestShareService.commandOutput")(function* (
    session: string,
    itemId: string,
  ) {
    const { thread, share, item, snapshotSequence } = yield* visibleItem(session, itemId);
    if (item.type !== "command_execution" || projectTurnItemForGuest(item, []) === null) {
      return yield* unavailable;
    }
    const roots = guestPathRoots([thread.worktreePath, yield* projectRootOf(thread)], home);
    // Closing, replacing, archiving, or deleting the share ends the output as it ends the stream.
    // A rename or model change keeps the share, so it does not.
    const untilClosed = orchestrator
      .streamStoredEventsFrom({ threadId: thread.id, afterSequence: snapshotSequence })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.archived" ||
            event.type === "thread.deleted" ||
            ((event.type === "thread.guest-share-updated" ||
              event.type === "thread.metadata-updated") &&
              event.payload.guestShare?.id !== share.id),
        ),
        Stream.runHead,
        Effect.ignore,
      );
    return commandOutputs.subscribe({ threadId: thread.id, itemId: item.id }).pipe(
      Stream.map(guestCommandOutputFrames(roots)),
      Stream.filter((frame) => frame !== null),
      // A replace carries the whole tail. Waiting here slows the pull, and the owner's stream
      // coalesces output meanwhile, so a busy command costs a guest about what it costs an owner
      // whose client fell behind.
      Stream.rechunk(1),
      Stream.throttle({
        cost: (frames) => frames.reduce((total, frame) => total + frame.text.length, 0),
        units: GUEST_COMMAND_OUTPUT_BYTES_PER_SECOND,
        duration: Duration.seconds(1),
        strategy: "shape",
      }),
      // A lost hub stream ends the output; the row reloads it when reopened.
      Stream.catchCause(() => Stream.empty),
      Stream.interruptWhen(Effect.race(untilExpiredOrHostLost(share), untilClosed)),
    );
  });

  const attachment = Effect.fn("GuestShareService.attachment")(function* (
    session: string,
    attachmentId: string,
  ) {
    const { share } = yield* authorize(session, "session");
    // A dismissed message's files are released; the guest's own waiting and sent ones show.
    const fromMessage = share.messages
      .flatMap((message) => (message.status === "dismissed" ? [] : (message.attachments ?? [])))
      .find((candidate) => candidate.id === attachmentId);
    // Once sent, the files are the thread's copies on the guest's own message row.
    const found =
      fromMessage ??
      (yield* guestSnapshot(session)).visibleItems
        .flatMap((item) =>
          item.type === "user_message" && isOwnGuestMessage(item, share.id) ? item.attachments : [],
        )
        .find((candidate) => candidate.id === attachmentId);
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
