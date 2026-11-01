import type { Session, WebContents } from "electron";
import { BrowserWindow, session } from "electron";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ElectronDialog from "../electron/ElectronDialog.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
/** Ephemeral partitions omit persist: but retain a product prefix so the webview gate recognizes them. */
const PREVIEW_EPHEMERAL_PARTITION_PREFIX = "t3code-preview-ephemeral-";
const PROFILE_PARTITION_MARKER = "profile-";

export type BrowserSessionPartitionNamespace = "profile";

// Electron's clipboard API uses clipboard-sanitized-write and checks both permission handlers.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "geolocation",
  // DesktopWindow confines HTML fullscreen to the guest's webview.
  "fullscreen",
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
  const crypto = yield* Crypto.Crypto;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // One prompt at a time, so a page cannot stack dialogs by looping a deep link.
  let permissionPromptOpen = false;
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
    if (permissionPromptOpen) {
      callback(undefined);
      return;
    }
    permissionPromptOpen = true;
    const settle = (answer: boolean | undefined) =>
      Effect.sync(() => {
        permissionPromptOpen = false;
        callback(answer);
      });
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "question",
            buttons: [...prompt.buttons],
            // Default to deny so an Enter typed into the page cannot accept a prompt it raised.
            defaultId: 1,
            cancelId: 1,
            message: prompt.message,
            ...(prompt.detail === undefined ? {} : { detail: prompt.detail }),
          },
          previewHostWindow(requester),
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
        buttons: ["Open", "Cancel"],
        message: `Open this ${new URL(url).protocol.slice(0, -1)} link?`,
        detail: `A page in the browser wants to open another application:\n\n${truncateForPrompt(url)}`,
      },
      (answer) => callback(answer === true),
    );
  };
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
          // Like Chrome, clipboard reads ask once per origin; both answers last for the session.
          const clipboardReadDecisions = new Map<string, boolean>();
          const confirmClipboardRead = (
            requester: WebContents,
            rawUrl: string | undefined,
            callback: (granted: boolean) => void,
          ): void => {
            const origin = permissionOrigin(rawUrl);
            if (origin === null) {
              callback(false);
              return;
            }
            const remembered = clipboardReadDecisions.get(origin);
            if (remembered !== undefined) {
              callback(remembered);
              return;
            }
            promptPermission(
              requester,
              {
                buttons: ["Allow", "Block"],
                message: `${truncateForPrompt(origin)} wants to see text and images copied to the clipboard`,
              },
              (answer) => {
                if (answer !== undefined) clipboardReadDecisions.set(origin, answer);
                callback(answer === true);
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
              if (permission === "clipboard-read") {
                confirmClipboardRead(
                  webContents,
                  "requestingUrl" in details ? details.requestingUrl : undefined,
                  callback,
                );
                return;
              }
              callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
            },
          );
          browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
            permission === "clipboard-read"
              ? clipboardReadDecisions.get(permissionOrigin(requestingOrigin) ?? "") === true
              : ALLOWED_PREVIEW_PERMISSIONS.has(permission),
          );
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      });
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
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }),
        { concurrency: "unbounded", discard: true },
      );
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
