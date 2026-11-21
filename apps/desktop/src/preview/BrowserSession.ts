import * as HostProcess from "@t3tools/shared/HostProcess";
import type { Certificate, Session, WebContents } from "electron";
import { BrowserWindow, session, systemPreferences } from "electron";
import { msg } from "gt-i18n";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { m } from "../i18n/messages.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
/** Ephemeral partitions omit persist: but retain a product prefix so the webview gate recognizes them. */
const PREVIEW_EPHEMERAL_PARTITION_PREFIX = "t3code-preview-ephemeral-";
const PROFILE_PARTITION_MARKER = "profile-";

export type BrowserSessionPartitionNamespace = "profile";

// Electron's clipboard API uses clipboard-sanitized-write and checks both permission handlers.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  // DesktopWindow confines HTML fullscreen to the guest's webview.
  "fullscreen",
  "pointerLock",
  // Loopback requests already succeed in Electron 44; permission-aware sign-in widgets query first.
  "loopback-network",
  // Deny local-fonts to untrusted previews: it exposes installed-font fingerprints and file bytes.
  // Deny notifications: pages could impersonate T3 Code; app notifications use the default session.
]);

const NEVER_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "http:",
  "https:",
  "javascript:",
  "view-source:",
]);

const externalProtocolPromptUrl = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return NEVER_EXTERNAL_PROTOCOLS.has(url.protocol) ? null : url.href;
  } catch {
    return null;
  }
};

// Teams sends Electron User-Agents to an error page before sign-in. Electron allows one listener per session.
const TEAMS_URL_PATTERNS = ["https://teams.cloud.microsoft/*", "https://teams.microsoft.com/*"];

const MAX_PROMPT_URL_LENGTH = 300;

const truncateForPrompt = (text: string): string =>
  text.length > MAX_PROMPT_URL_LENGTH ? `${text.slice(0, MAX_PROMPT_URL_LENGTH)}…` : text;

const permissionOrigin = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null;
  try {
    const { origin } = new URL(rawUrl);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

/**
 * Certificate errors a user may accept for a preview page, with the reason the
 * prompt shows. Every other error keeps Electron's denial.
 */
const OVERRIDABLE_CERTIFICATE_ERRORS: ReadonlyMap<string, string> = new Map([
  ["net::ERR_CERT_AUTHORITY_INVALID", msg("No trusted authority issued this certificate.")],
  ["net::ERR_CERT_COMMON_NAME_INVALID", msg("This certificate is not for this address.")],
  ["net::ERR_CERT_DATE_INVALID", msg("This certificate has expired or is not valid yet.")],
]);

/**
 * A `wss:` socket reaches the same TLS endpoint as the page, so it shares the
 * `https:` origin. It must: a socket is never a main frame, so it could not be
 * approved on its own, and a page's dev-server socket would stay blocked.
 */
const certificateOrigin = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "wss:" ? `https://${url.host}` : null;
  } catch {
    return null;
  }
};

const CertificateApproval = Schema.Struct({
  origin: Schema.String,
  fingerprint: Schema.String,
  error: Schema.String,
});
type CertificateApproval = typeof CertificateApproval.Type;
const CertificateApprovalsJson = Schema.fromJsonString(Schema.Array(CertificateApproval));
const decodeCertificateApprovals = Schema.decodeEffect(CertificateApprovalsJson);
const encodeCertificateApprovals = Schema.encodeEffect(CertificateApprovalsJson);

const certificateApprovalKey = ({ origin, fingerprint, error }: CertificateApproval): string =>
  JSON.stringify([origin, fingerprint, error]);

/** Kept beside the profile's cookies, so it lives and dies with them. */
const CERTIFICATE_APPROVALS_FILE = "t3code-certificate-approvals.json";

/** Server-chosen certificate names must not add lines or flood the prompt. */
const promptCertificateName = (name: string): string => {
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};

const promptCertificateDate = (seconds: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(seconds * 1000));

/** The certificates a user accepted in one preview Session. */
interface CertificateTrust {
  /** `null` for an incognito Session, whose approvals end with the process. */
  readonly file: string | null;
  readonly approvals: Map<string, CertificateApproval>;
  /** Bumped by each revocation, so an answer to an older prompt cannot restore trust. */
  revocations: number;
}

type MediaDevice = "camera" | "microphone";

const mediaDeviceFor = (mediaType: string | undefined): MediaDevice | null =>
  mediaType === "video" ? "camera" : mediaType === "audio" ? "microphone" : null;

// Whole sentences per device set, so each language can phrase them its own way.
const mediaRequestMessage = (devices: ReadonlyArray<MediaDevice>, origin: string): string =>
  devices.length === 2
    ? m(msg("{origin} wants to use your camera and microphone"), { origin })
    : devices[0] === "microphone"
      ? m(msg("{origin} wants to use your microphone"), { origin })
      : m(msg("{origin} wants to use your camera"), { origin });

const mediaBlockedMessage = (devices: ReadonlyArray<MediaDevice>): string =>
  devices.length === 2
    ? m(msg("macOS blocked T3 Code from using your camera and microphone"))
    : devices[0] === "microphone"
      ? m(msg("macOS blocked T3 Code from using your microphone"))
      : m(msg("macOS blocked T3 Code from using your camera"));

/**
 * macOS gates capture devices per app and lists an app under Privacy & Security
 * only after it asks, so ask the OS once the user allowed the page.
 */
const ensureSystemMediaAccess = async (
  platform: NodeJS.Platform,
  devices: ReadonlyArray<MediaDevice>,
): Promise<boolean> => {
  if (platform !== "darwin") return true;
  const statuses = devices.map((device) => systemPreferences.getMediaAccessStatus(device));
  if (statuses.some((status) => status !== "granted" && status !== "not-determined")) return false;
  const results = await Promise.all(
    devices.map((device, index) =>
      statuses[index] === "granted"
        ? true
        : systemPreferences.askForMediaAccess(device).catch(() => false),
    ),
  );
  return results.every(Boolean);
};

/** The camera and microphone answers given in one preview Session. */
interface MediaConsent {
  readonly decisions: Map<string, boolean>;
  /** Bumped by each reset, so an answer to an older prompt cannot restore a decision. */
  resets: number;
}

export class BrowserSessionPartitionDerivationError extends Schema.TaggedError<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedError<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedError<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedError<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    /** Omit `partitions` to clear every known partition. */
    readonly clearCookies: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionStorageClearError>;
    /** For cookies cleared outside `clearCookies`, such as over a tab's CDP session. */
    readonly cookiesCleared: (
      browserSession: Session,
    ) => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionCacheClearError>;
  }
>()("@t3tools/desktop/preview/BrowserSession") {}

const selectSessions = (
  sessions: ReadonlyMap<string, Session>,
  partitions: ReadonlyArray<string> | undefined,
): ReadonlyArray<readonly [string, Session]> =>
  [...sessions.entries()].filter(
    ([partition]) => partitions === undefined || partitions.includes(partition),
  );

/** Escape lone surrogates before UTF-8 hashing, which otherwise merges them with U+FFFD; escape backslashes too. */
const encodeScopeForDigest = (scope: string): Uint8Array =>
  new TextEncoder().encode(
    scope
      .replace(/\\/g, "\\\\")
      .replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
  );

// Webview guests have no window; use their embedding page.
const previewHostWindow = (guest: WebContents | null): BrowserWindow | undefined => {
  if (guest === null || guest.isDestroyed()) return undefined;
  const host = guest.hostWebContents ?? guest;
  if (host.isDestroyed()) return undefined;
  return BrowserWindow.fromWebContents(host) ?? undefined;
};

/** @public */
export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Digest.Digest;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // One prompt at a time, so a page cannot stack dialogs by looping a deep link.
  let permissionPromptOpen = false;
  let mediaRecoveryOpen = false;
  /** Settles with `undefined` when the user gave no answer: another prompt was open or the dialog failed. */
  const promptPermission = (
    requester: WebContents | null,
    prompt: {
      readonly buttons: readonly [allow: string, deny: string];
      readonly message: string;
      readonly detail?: string;
    },
    callback: (answer: boolean | undefined) => void,
  ): void => {
    if (permissionPromptOpen || requester?.isDestroyed()) {
      callback(undefined);
      return;
    }
    permissionPromptOpen = true;
    const dismiss = new AbortController();
    const abandon = () => dismiss.abort();
    requester?.once("destroyed", abandon);
    const settle = (answer: boolean | undefined) =>
      Effect.sync(() => {
        permissionPromptOpen = false;
        requester?.off("destroyed", abandon);
        callback(dismiss.signal.aborted || requester?.isDestroyed() ? undefined : answer);
      });
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "question",
            signal: dismiss.signal,
            buttons: [...prompt.buttons],
            // Default to deny so an Enter typed into the page cannot accept a prompt it raised.
            defaultId: 1,
            cancelId: 1,
            message: prompt.message,
            ...(prompt.detail === undefined ? {} : { detail: prompt.detail }),
          },
          platform === "win32" ? undefined : previewHostWindow(requester),
        )
        .pipe(
          Effect.map(({ response }): boolean | undefined => response === 0),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap(settle),
          Effect.onInterrupt(() => settle(undefined)),
        ),
    );
  };
  /** Electron launches external protocols after granting openExternal; untrusted pages require confirmation. */
  const confirmOpenExternal = (
    requester: WebContents | null,
    rawUrl: string | undefined,
    callback: (granted: boolean) => void,
  ): void => {
    const url = externalProtocolPromptUrl(rawUrl);
    if (url === null) {
      callback(false);
      return;
    }
    promptPermission(
      requester,
      {
        buttons: [
          m(msg("Open", { $context: "button, opens a link in another app" })),
          m(msg("Cancel")),
        ],
        message: m(msg("Open this {protocol} link?"), {
          protocol: new URL(url).protocol.slice(0, -1),
        }),
        detail: m(msg("A page in the browser wants to open another application:\n\n{url}"), {
          url: truncateForPrompt(url),
        }),
      },
      (answer) => callback(answer === true),
    );
  };

  const certificateTrust = new WeakMap<Session, CertificateTrust>();
  const writeCertificateApprovals = yield* Semaphore.make(1);
  const loadCertificateTrust = Effect.fn("BrowserSession.loadCertificateTrust")(function* (
    browserSession: Session,
  ) {
    const file =
      browserSession.storagePath == null
        ? null
        : path.join(browserSession.storagePath, CERTIFICATE_APPROVALS_FILE);
    const approvals: ReadonlyArray<CertificateApproval> =
      file === null
        ? []
        : yield* fileSystem.readFileString(file).pipe(
            Effect.flatMap(decodeCertificateApprovals),
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
            }),
            Effect.catch((cause) =>
              Effect.logWarning("Ignored saved certificate approvals.", { file, cause }).pipe(
                Effect.as([]),
              ),
            ),
          );
    const trust: CertificateTrust = {
      file,
      approvals: new Map(approvals.map((approval) => [certificateApprovalKey(approval), approval])),
      revocations: 0,
    };
    return trust;
  });
  const writeApprovalsFile = Effect.fn("BrowserSession.writeApprovalsFile")(function* (
    file: string,
    approvals: ReadonlyMap<string, CertificateApproval>,
  ) {
    if (approvals.size === 0) return yield* fileSystem.remove(file, { force: true });
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(
      file,
      yield* encodeCertificateApprovals([...approvals.values()]),
    );
  });
  /**
   * Saved before it is trusted, so a failed write cannot leave an approval that
   * silently ends at restart. Writes share one lock, so a slower write cannot
   * restore stale data.
   */
  const rememberCertificate = Effect.fn("BrowserSession.rememberCertificate")(function* (
    trust: CertificateTrust,
    key: string,
    approval: CertificateApproval,
    revocations: number,
  ) {
    if (trust.revocations !== revocations) return false;
    if (trust.file !== null) {
      yield* writeApprovalsFile(trust.file, new Map(trust.approvals).set(key, approval));
      // A revocation during the write queues its own rewrite behind this one.
      if (trust.revocations !== revocations) return false;
    }
    trust.approvals.set(key, approval);
    return true;
  }, writeCertificateApprovals.withPermits(1));
  /**
   * Rewrites the file from memory. Clearing cookies runs this even when memory
   * is already empty, so retrying after a failed removal still deletes the file.
   */
  const saveCertificateApprovals = Effect.fn("BrowserSession.saveCertificateApprovals")(function* (
    trust: CertificateTrust,
  ) {
    if (trust.file !== null) yield* writeApprovalsFile(trust.file, trust.approvals);
  }, writeCertificateApprovals.withPermits(1));

  // One prompt at a time; tabs that hit the same certificate wait on it.
  let certificatePrompt: {
    readonly trust: CertificateTrust;
    readonly key: string;
    readonly callbacks: Array<(trusted: boolean) => void>;
  } | null = null;
  const confirmCertificate = (
    contents: WebContents,
    trust: CertificateTrust,
    approval: CertificateApproval,
    certificate: Certificate,
    reason: string,
    callback: (trusted: boolean) => void,
  ): void => {
    const key = certificateApprovalKey(approval);
    if (certificatePrompt !== null) {
      if (certificatePrompt.trust === trust && certificatePrompt.key === key) {
        certificatePrompt.callbacks.push(callback);
      } else {
        callback(false);
      }
      return;
    }
    const prompt = { trust, key, callbacks: [callback] };
    certificatePrompt = prompt;
    // A prompt for a tab that closed or moved on would approve a page nobody is waiting for.
    const dismiss = new AbortController();
    const abandon = () => dismiss.abort();
    const navigated = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) abandon();
    };
    contents.once("destroyed", abandon);
    contents.on("did-start-navigation", navigated);
    const settle = (trusted: boolean) =>
      Effect.sync(() => {
        certificatePrompt = null;
        if (!contents.isDestroyed()) {
          contents.off("destroyed", abandon);
          contents.off("did-start-navigation", navigated);
        }
        for (const waiter of prompt.callbacks) waiter(trusted);
      });
    const host = new URL(approval.origin).host;
    const revocations = trust.revocations;
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "warning",
            buttons: [m(msg("Trust and Remember")), m(msg("Cancel"))],
            defaultId: 1,
            cancelId: 1,
            signal: dismiss.signal,
            message: m(msg("{host} has an untrusted certificate"), { host }),
            detail: [
              m(reason),
              "",
              m(msg("Issued to: {name}"), {
                name: promptCertificateName(certificate.subjectName),
              }),
              m(msg("Issued by: {name}"), { name: promptCertificateName(certificate.issuerName) }),
              m(msg("Valid: {start} – {end}"), {
                start: promptCertificateDate(certificate.validStart),
                end: promptCertificateDate(certificate.validExpiry),
              }),
              m(msg("Fingerprint: {fingerprint}"), { fingerprint: approval.fingerprint }),
              "",
              m(
                msg(
                  "Trust it only if you know this certificate belongs to the site. Clearing this browser profile's cookies forgets it.",
                ),
              ),
            ].join("\n"),
          },
          // In the reporter's Windows test, a box owned by the host window
          // blocked all mouse input, its own buttons included, until it closed.
          platform === "win32" ? undefined : previewHostWindow(contents),
        )
        .pipe(
          Effect.flatMap(({ response }) =>
            response === 0 && !dismiss.signal.aborted
              ? rememberCertificate(trust, key, approval, revocations).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to save a certificate approval.", { cause }).pipe(
                      Effect.andThen(
                        electronDialog.showErrorBox(
                          m(msg("Could not trust the certificate for {host}"), { host }),
                          m(
                            msg(
                              "T3 Code could not save this approval, so the page stays blocked. Check that the disk is not full and its data folder is writable, then try again.",
                            ),
                          ),
                        ),
                      ),
                      Effect.as(false),
                    ),
                  ),
                )
              : Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => false),
          Effect.flatMap(settle),
          Effect.onInterrupt(() => settle(false)),
        ),
    );
  };
  yield* electronApp.on(
    "certificate-error",
    (
      event: Electron.Event,
      contents: WebContents,
      url: string,
      error: string,
      certificate: Certificate,
      callback: (trusted: boolean) => void,
      isMainFrame: boolean,
    ) => {
      if (contents.isDestroyed()) return;
      // Sessions this service did not create keep Electron's denial.
      const trust = certificateTrust.get(contents.session);
      const origin = certificateOrigin(url);
      const reason = OVERRIDABLE_CERTIFICATE_ERRORS.get(error);
      if (trust === undefined || origin === null || reason === undefined) return;
      const approval = { origin, fingerprint: certificate.fingerprint, error };
      event.preventDefault();
      if (trust.approvals.has(certificateApprovalKey(approval))) {
        callback(true);
        return;
      }
      // Only a page navigation asks; a subresource the user has not accepted stays blocked.
      if (!isMainFrame) {
        callback(false);
        return;
      }
      confirmCertificate(contents, trust, approval, certificate, reason, callback);
    },
  );

  /** Clearing a profile's cookies also forgets the certificates its user trusted. */
  const revokeCertificates = Effect.fn("BrowserSession.revokeCertificates")(function* (
    partition: string,
    browserSession: Session,
  ) {
    const trust = certificateTrust.get(browserSession);
    if (trust === undefined) return;
    const hadApprovals = trust.approvals.size > 0;
    trust.revocations += 1;
    trust.approvals.clear();
    const saved = yield* saveCertificateApprovals(trust).pipe(Effect.result);
    // An open connection already passed its certificate check.
    if (hadApprovals) {
      yield* Effect.tryPromise({
        try: () => browserSession.closeAllConnections(),
        catch: (cause) => new BrowserSessionStorageClearError({ partition, cause }),
      });
    }
    if (Result.isFailure(saved)) {
      return yield* new BrowserSessionStorageClearError({ partition, cause: saved.failure });
    }
  });

  /** Camera and microphone answers by Session; clearing a profile's cookies forgets them too. */
  const mediaConsentBySession = new WeakMap<Session, MediaConsent>();
  const forgetMediaDecisions = (browserSession: Session): void => {
    const consent = mediaConsentBySession.get(browserSession);
    if (consent === undefined) return;
    consent.resets += 1;
    consent.decisions.clear();
  };

  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (
    scope = "shared",
    persistent = true,
    namespace?: BrowserSessionPartitionNamespace,
  ) {
    const digest = yield* crypto.digest(Digest.sha256, encodeScopeForDigest(scope)).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserSessionPartitionDerivationError({
            scope,
            cause,
          }),
      ),
    );
    const prefix = persistent ? PREVIEW_PARTITION_PREFIX : PREVIEW_EPHEMERAL_PARTITION_PREFIX;
    return `${prefix}${namespace === "profile" ? PROFILE_PARTITION_MARKER : ""}${Hex.encode(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (
    scope = "shared",
    persistent = true,
    namespace?: BrowserSessionPartitionNamespace,
  ) {
    const partition = yield* getPartition(scope, persistent, namespace);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          // Location and clipboard decisions are remembered separately for each origin.
          const permissionDecisions = {
            "clipboard-read": new Map<string, boolean>(),
            geolocation: new Map<string, boolean>(),
          };
          const confirmOriginPermission = (
            requester: WebContents,
            permission: keyof typeof permissionDecisions,
            rawUrl: string | undefined,
            callback: (granted: boolean) => void,
          ): void => {
            const origin = permissionOrigin(rawUrl);
            if (origin === null) {
              // A frame URL such as about:srcdoc cannot establish whether its origin is inherited or opaque.
              callback(false);
              return;
            }
            const decisions = permissionDecisions[permission];
            const remembered = decisions.get(origin);
            if (remembered !== undefined) {
              callback(remembered);
              return;
            }
            promptPermission(
              requester,
              {
                buttons: [
                  m(msg("Allow", { $context: "button, grants a site permission" })),
                  m(msg("Block", { $context: "button, denies a site permission" })),
                ],
                message:
                  permission === "geolocation"
                    ? m(msg("{origin} wants to know your location"), {
                        origin: truncateForPrompt(origin),
                      })
                    : m(msg("{origin} wants to see text and images copied to the clipboard"), {
                        origin: truncateForPrompt(origin),
                      }),
              },
              (answer) => {
                if (answer !== undefined) decisions.set(origin, answer);
                callback(answer === true);
              },
            );
          };
          // Camera and microphone ask once per origin and device, like clipboard reads.
          const mediaConsent: MediaConsent = { decisions: new Map(), resets: 0 };
          mediaConsentBySession.set(browserSession, mediaConsent);
          const mediaDecisions = mediaConsent.decisions;
          const mediaKey = (origin: string, device: MediaDevice) => `${device} ${origin}`;
          const confirmMedia = (
            requester: WebContents,
            rawUrl: string | undefined,
            mediaTypes: ReadonlyArray<string> | undefined,
            callback: (granted: boolean) => void,
          ): void => {
            const origin = permissionOrigin(rawUrl);
            const devices = [
              ...new Set((mediaTypes ?? []).map(mediaDeviceFor).filter((d) => d !== null)),
            ];
            if (origin === null || devices.length === 0) {
              callback(false);
              return;
            }
            // A reset while a prompt or the macOS check is pending must not grant or remember.
            const resets = mediaConsent.resets;
            const isStale = () =>
              mediaConsent.resets !== resets || requester?.isDestroyed() === true;
            const finish = (granted: boolean) => {
              if (!granted || isStale()) {
                callback(false);
                return;
              }
              void ensureSystemMediaAccess(platform, devices).then(
                (systemGranted) => {
                  if (isStale()) {
                    callback(false);
                    return;
                  }
                  if (!systemGranted && !mediaRecoveryOpen) {
                    mediaRecoveryOpen = true;
                    runFork(
                      electronDialog
                        .showMessageBox(
                          {
                            type: "info",
                            buttons: [m(msg("OK"))],
                            message: mediaBlockedMessage(devices),
                            detail: m(
                              msg(
                                "Allow T3 Code in System Settings › Privacy & Security, then restart T3 Code.",
                              ),
                            ),
                          },
                          previewHostWindow(requester),
                        )
                        .pipe(
                          Effect.ignore,
                          Effect.ensuring(
                            Effect.sync(() => {
                              mediaRecoveryOpen = false;
                            }),
                          ),
                        ),
                    );
                  }
                  callback(systemGranted);
                },
                () => callback(false),
              );
            };
            const remembered = devices.map((device) =>
              mediaDecisions.get(mediaKey(origin, device)),
            );
            if (remembered.some((answer) => answer === false)) {
              callback(false);
              return;
            }
            if (remembered.every((answer) => answer === true)) {
              finish(true);
              return;
            }
            const undecided = devices.filter(
              (device) => !mediaDecisions.has(mediaKey(origin, device)),
            );
            promptPermission(
              requester,
              {
                buttons: [
                  m(msg("Allow", { $context: "button, grants a site permission" })),
                  m(msg("Block", { $context: "button, denies a site permission" })),
                ],
                message: mediaRequestMessage(undecided, truncateForPrompt(origin)),
              },
              (answer) => {
                if (answer !== undefined && !isStale()) {
                  for (const device of undecided)
                    mediaDecisions.set(mediaKey(origin, device), answer);
                }
                finish(answer === true);
              },
            );
          };
          // Rewriting Electron's native User-Agent makes Turnstile fail integrity checks with error 600010.
          browserSession.setPermissionRequestHandler(
            (webContents, permission, callback, details) => {
              if (permission === "openExternal") {
                confirmOpenExternal(
                  webContents,
                  "externalURL" in details ? details.externalURL : undefined,
                  callback,
                );
                return;
              }
              if (permission === "clipboard-read" || permission === "geolocation") {
                confirmOriginPermission(
                  webContents,
                  permission,
                  "requestingUrl" in details ? details.requestingUrl : undefined,
                  callback,
                );
                return;
              }
              if (permission === "media") {
                confirmMedia(
                  webContents,
                  ("securityOrigin" in details ? details.securityOrigin : undefined) ??
                    details.requestingUrl,
                  "mediaTypes" in details ? details.mediaTypes : undefined,
                  callback,
                );
                return;
              }
              callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
            },
          );
          browserSession.setPermissionCheckHandler(
            (_webContents, permission, requestingOrigin, details) => {
              if (permission === "clipboard-read" || permission === "geolocation") {
                return (
                  permissionDecisions[permission].get(permissionOrigin(requestingOrigin) ?? "") ===
                  true
                );
              }
              if (permission === "media") {
                const origin = permissionOrigin(requestingOrigin);
                const device = mediaDeviceFor(details?.mediaType);
                return (
                  origin !== null &&
                  device !== null &&
                  mediaDecisions.get(mediaKey(origin, device)) === true &&
                  (platform !== "darwin" ||
                    systemPreferences.getMediaAccessStatus(device) === "granted")
                );
              }
              return ALLOWED_PREVIEW_PERMISSIONS.has(permission);
            },
          );
          browserSession.webRequest.onBeforeSendHeaders(
            { urls: TEAMS_URL_PATTERNS },
            ({ requestHeaders }, callback) => {
              const userAgent = Object.entries(requestHeaders).find(
                ([name]) => name.toLowerCase() === "user-agent",
              );
              if (userAgent === undefined) {
                callback({});
                return;
              }
              const [name, value] = userAgent;
              callback({
                requestHeaders: { ...requestHeaders, [name]: value.replace(/ Electron\/\S+/, "") },
              });
            },
          );
          return browserSession;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      }).pipe(
        Effect.flatMap((browserSession) =>
          loadCertificateTrust(browserSession).pipe(
            Effect.map((trust) => {
              certificateTrust.set(browserSession, trust);
              const next = new Map(sessions);
              next.set(partition, browserSession);
              return [browserSession, next] as const;
            }),
          ),
        ),
      );
    });
  });

  return BrowserSession.of({
    getPartition,
    isPartition: (partition) =>
      partition.startsWith(PREVIEW_PARTITION_PREFIX) ||
      partition.startsWith(PREVIEW_EPHEMERAL_PARTITION_PREFIX),
    getSession,
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* (partitions?) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      const selected = selectSessions(sessions, partitions);
      for (const [, browserSession] of selected) forgetMediaDecisions(browserSession);
      yield* Effect.forEach(
        selected,
        ([partition, browserSession]) =>
          Effect.gen(function* () {
            const cleared = yield* Effect.tryPromise({
              try: () =>
                browserSession.clearStorageData({
                  storages: [
                    "cookies",
                    "localstorage",
                    "indexdb",
                    "serviceworkers",
                    "cachestorage",
                  ],
                }),
              catch: (cause) =>
                new BrowserSessionStorageClearError({
                  partition,
                  cause,
                }),
            }).pipe(Effect.result);
            // Approvals go even when the storage clear fails, since the user asked to forget them.
            yield* revokeCertificates(partition, browserSession);
            if (Result.isFailure(cleared)) return yield* cleared.failure;
          }),
        { concurrency: "unbounded", discard: true },
      );
    }),
    cookiesCleared: Effect.fn("BrowserSession.cookiesCleared")(function* (browserSession) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      for (const [partition, candidate] of sessions) {
        if (candidate !== browserSession) continue;
        forgetMediaDecisions(browserSession);
        yield* revokeCertificates(partition, browserSession);
      }
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* (partitions?) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.forEach(
        selectSessions(sessions, partitions),
        ([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
