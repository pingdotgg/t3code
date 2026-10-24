import * as HostProcess from "@t3tools/shared/HostProcess";
import type { Certificate, Session, WebContents } from "electron";
import { BrowserWindow, session } from "electron";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
/**
 * Incognito partitions deliberately omit the `persist:` prefix, which is what
 * makes Chromium keep them in memory and discard them with the process. They
 * still carry the product prefix so `isPartition` can admit them — the
 * `will-attach-webview` gate rejects anything it does not recognise.
 */
const PREVIEW_EPHEMERAL_PARTITION_PREFIX = "t3code-preview-ephemeral-";
const PROFILE_PARTITION_MARKER = "profile-";

export type BrowserSessionPartitionNamespace = "profile";

// `clipboard-sanitized-write` is the Electron permission behind
// `navigator.clipboard.writeText()` — note it is NOT `clipboard-write`, which
// is not a valid Electron permission name. Async clipboard writes are gated by
// the permission *check* handler (not only the request handler), so both
// handlers must allow it; otherwise built-in "Copy" buttons — e.g. the Next.js
// / Vercel error overlay — fail with `Failed to execute 'writeText' on
// 'Clipboard': Write permission denied`.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "geolocation",
  // `DesktopWindow` disables HTML fullscreen window resizing for the app window
  // and every preview guest, so a page that goes fullscreen fills its own
  // webview instead of taking over the whole T3 window.
  "fullscreen",
  // Deliberately NOT local-fonts: preview sessions run untrusted web content,
  // and silently granting it would hand every page the user's installed-font
  // fingerprint (and font file bytes via FontData.blob()).
  // Deliberately NOT notifications: a page could post OS notifications branded
  // as T3 Code. T3's own come from the app window on the default session.
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

const MAX_PROMPT_URL_LENGTH = 300;

/**
 * Certificate errors a user may accept for a preview page, with the reason the
 * prompt shows. Every other error keeps Electron's denial.
 */
const OVERRIDABLE_CERTIFICATE_ERRORS: ReadonlyMap<string, string> = new Map([
  ["net::ERR_CERT_AUTHORITY_INVALID", "No trusted authority issued this certificate."],
  ["net::ERR_CERT_COMMON_NAME_INVALID", "This certificate is not for this address."],
  ["net::ERR_CERT_DATE_INVALID", "This certificate has expired or is not valid yet."],
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

/**
 * `TextEncoder` replaces a lone UTF-16 surrogate with U+FFFD, so `"p\ud800"`
 * and `"p\ufffd"` would hash to the same partition and share cookies. Those
 * are distinct, supported ids, so lone surrogates are escaped to `\uXXXX`
 * first — and a literal backslash is doubled so the escape cannot be forged.
 */
const encodeScopeForDigest = (scope: string): Uint8Array =>
  new TextEncoder().encode(
    scope
      .replace(/\\/g, "\\\\")
      .replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
  );

/**
 * A `<webview>` guest has no window of its own, so look it up through the page
 * that embeds it.
 */
const previewHostWindow = (guest: WebContents | null): BrowserWindow | undefined => {
  if (guest === null || guest.isDestroyed()) return undefined;
  const host = guest.hostWebContents ?? guest;
  if (host.isDestroyed()) return undefined;
  return BrowserWindow.fromWebContents(host) ?? undefined;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // One prompt at a time, so a page cannot stack dialogs by looping a deep link.
  let externalPromptOpen = false;
  /**
   * Electron grants an external-protocol navigation through the `openExternal`
   * permission and then launches the OS handler itself. Ask first: previews run
   * untrusted pages, and a silent grant would let any of them launch apps.
   */
  const confirmOpenExternal = (
    requester: WebContents | null,
    rawUrl: string | undefined,
    callback: (granted: boolean) => void,
  ): void => {
    const url = externalProtocolPromptUrl(rawUrl);
    if (url === null || externalPromptOpen) {
      callback(false);
      return;
    }
    externalPromptOpen = true;
    const settle = (granted: boolean) =>
      Effect.sync(() => {
        externalPromptOpen = false;
        callback(granted);
      });
    const shownUrl =
      url.length > MAX_PROMPT_URL_LENGTH ? `${url.slice(0, MAX_PROMPT_URL_LENGTH)}…` : url;
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "question",
            buttons: ["Open", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: `Open this ${new URL(url).protocol.slice(0, -1)} link?`,
            detail: `A page in the browser wants to open another application:\n\n${shownUrl}`,
          },
          previewHostWindow(requester),
        )
        .pipe(
          Effect.map(({ response }) => response === 0),
          Effect.orElseSucceed(() => false),
          Effect.flatMap(settle),
          Effect.onInterrupt(() => settle(false)),
        ),
    );
  };

  const certificateTrust = new WeakMap<Session, CertificateTrust>();
  const writeCertificateApprovals = yield* Semaphore.make(1);
  const loadCertificateTrust = (browserSession: Session) => {
    const file =
      browserSession.storagePath == null
        ? null
        : path.join(browserSession.storagePath, CERTIFICATE_APPROVALS_FILE);
    return (
      file === null
        ? Effect.succeed([])
        : fileSystem.readFileString(file).pipe(
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
          )
    ).pipe(
      Effect.map((approvals): CertificateTrust => ({
        file,
        approvals: new Map(
          approvals.map((approval) => [certificateApprovalKey(approval), approval]),
        ),
        revocations: 0,
      })),
    );
  };
  const writeApprovalsFile = (file: string, approvals: ReadonlyMap<string, CertificateApproval>) =>
    approvals.size === 0
      ? fileSystem.remove(file, { force: true })
      : Effect.gen(function* () {
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
  const rememberCertificate = (
    trust: CertificateTrust,
    key: string,
    approval: CertificateApproval,
    revocations: number,
  ) =>
    writeCertificateApprovals.withPermits(1)(
      Effect.gen(function* () {
        if (trust.revocations !== revocations) return false;
        if (trust.file !== null) {
          yield* writeApprovalsFile(trust.file, new Map(trust.approvals).set(key, approval));
          // A revocation during the write queues its own rewrite behind this one.
          if (trust.revocations !== revocations) return false;
        }
        trust.approvals.set(key, approval);
        return true;
      }),
    );
  /**
   * Rewrites the file from memory. Clearing cookies runs this even when memory
   * is already empty, so retrying after a failed removal still deletes the file.
   */
  const saveCertificateApprovals = (trust: CertificateTrust) =>
    writeCertificateApprovals.withPermits(1)(
      Effect.suspend(() =>
        trust.file === null ? Effect.void : writeApprovalsFile(trust.file, trust.approvals),
      ),
    );

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
    const settle = (trusted: boolean) =>
      Effect.sync(() => {
        certificatePrompt = null;
        for (const waiter of prompt.callbacks) waiter(trusted);
      });
    const host = new URL(approval.origin).host;
    const revocations = trust.revocations;
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "warning",
            buttons: ["Trust and Remember", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: `${host} has an untrusted certificate`,
            detail: [
              reason,
              "",
              `Issued to: ${promptCertificateName(certificate.subjectName)}`,
              `Issued by: ${promptCertificateName(certificate.issuerName)}`,
              `Valid: ${promptCertificateDate(certificate.validStart)} – ${promptCertificateDate(certificate.validExpiry)}`,
              `Fingerprint: ${approval.fingerprint}`,
              "",
              "Trust it only if you know this certificate belongs to the site. Clearing this browser profile's cookies forgets it.",
            ].join("\n"),
          },
          // In the reporter's Windows test, a box owned by the host window
          // blocked all mouse input, its own buttons included, until it closed.
          platform === "win32" ? undefined : previewHostWindow(contents),
        )
        .pipe(
          Effect.flatMap(({ response }) =>
            response === 0
              ? rememberCertificate(trust, key, approval, revocations).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to save a certificate approval.", { cause }).pipe(
                      Effect.andThen(
                        electronDialog.showErrorBox(
                          `Could not trust the certificate for ${host}`,
                          "T3 Code could not save this approval, so the page stays blocked. Check that the disk is not full and its data folder is writable, then try again.",
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
    // An open connection already passed its certificate check.
    if (hadApprovals) {
      yield* Effect.tryPromise({
        try: () => browserSession.closeAllConnections(),
        catch: (cause) => new BrowserSessionStorageClearError({ partition, cause }),
      });
    }
    yield* saveCertificateApprovals(trust).pipe(
      Effect.mapError((cause) => new BrowserSessionStorageClearError({ partition, cause })),
    );
  });

  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (
    scope = "shared",
    persistent = true,
    namespace?: BrowserSessionPartitionNamespace,
  ) {
    const digest = yield* crypto.digest("SHA-256", encodeScopeForDigest(scope)).pipe(
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
          // The guest keeps Electron's native User-Agent. Rewriting it in any
          // form — even variants that keep the Electron token — makes Cloudflare
          // Turnstile fail its integrity check with error 600010 and recreate
          // the challenge every few seconds, so logins behind it never complete
          // (#5002).
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
              callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
            },
          );
          browserSession.setPermissionCheckHandler((_webContents, permission) =>
            ALLOWED_PREVIEW_PERMISSIONS.has(permission),
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
      yield* Effect.forEach(
        selectSessions(sessions, partitions),
        ([partition, browserSession]) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                browserSession.clearStorageData({
                  storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
                }),
              catch: (cause) =>
                new BrowserSessionStorageClearError({
                  partition,
                  cause,
                }),
            });
            yield* revokeCertificates(partition, browserSession);
          }),
        { concurrency: "unbounded", discard: true },
      );
    }),
    cookiesCleared: Effect.fn("BrowserSession.cookiesCleared")(function* (browserSession) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      for (const [partition, candidate] of sessions) {
        if (candidate === browserSession) yield* revokeCertificates(partition, browserSession);
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
