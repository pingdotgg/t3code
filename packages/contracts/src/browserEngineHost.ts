/**
 * Private wire types for the authenticated browser engine host.
 *
 * A desktop renderer that owns Chromium guests registers as the environment's
 * engine host over its authenticated WebSocket. Registration is accepted only
 * from the desktop's own bootstrap session, so web, mobile, relay and tunnel
 * clients can never become a host: with no host, engine commands on
 * `t3.browser/sessions` stay named-unsupported.
 *
 * The host claims each guest it renders under an engine generation (the
 * serialized webContents id, shared with `t3.browser/frames`). Only the
 * claiming connection may report page status or answer commands for that
 * generation; a second host needs an explicit handoff, which fences the old
 * generation out. None of these methods are reachable from extensions.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserFrameEngineGeneration } from "./browserFrames.ts";
import {
  BrowserImportFailureReason,
  BrowserImportSourceId,
  BrowserImportUnavailableReason,
} from "./browserImport.ts";
import {
  BROWSER_PROFILE_MAX_COUNT,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BrowserProfileId,
} from "./browserProfile.ts";
import {
  PREVIEW_URL_MAX_LENGTH,
  PreviewAppearancePreference,
  PreviewNavStatus,
  PreviewTabId,
  PreviewZoomFactor,
} from "./preview.ts";

/** Max favicon data URL length, matching the desktop bridge's own bound. */
export const BROWSER_ENGINE_FAVICON_MAX_LENGTH = 8192;

export const BrowserEngineHostConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type BrowserEngineHostConnectionId = typeof BrowserEngineHostConnectionId.Type;

export const BrowserEngineCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type BrowserEngineCommandId = typeof BrowserEngineCommandId.Type;

/**
 * Page commands. Resize and privileged verbs are not here. `navigate` loads
 * the URL the server already recorded as the session's request, so the
 * owner's next report settles it. `setPictureInPicture` pops the guest out
 * into the host's native picture-in-picture window; the server gates it on
 * its own grant.
 */
export const BrowserEngineCommand = Schema.Union([
  Schema.TaggedStruct("navigate", {
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH)),
  }),
  Schema.TaggedStruct("back", {}),
  Schema.TaggedStruct("forward", {}),
  Schema.TaggedStruct("reload", {}),
  /** Bypasses the HTTP cache; cookies and storage are untouched. */
  Schema.TaggedStruct("hardReload", {}),
  Schema.TaggedStruct("zoom", { zoomFactor: PreviewZoomFactor }),
  Schema.TaggedStruct("setAppearance", { appearance: PreviewAppearancePreference }),
  Schema.TaggedStruct("setAudioMuted", { muted: Schema.Boolean }),
  /** Opens (detached) or closes the guest's DevTools. Gated by its own extension grant. */
  Schema.TaggedStruct("setDevToolsOpen", { open: Schema.Boolean }),
  Schema.TaggedStruct("setPictureInPicture", { open: Schema.Boolean }),
]);
export type BrowserEngineCommand = typeof BrowserEngineCommand.Type;

/**
 * Opaque handle for one profile inside an import source. The host re-lists
 * the source on import and resolves the handle there, so source profile
 * directory names never cross the wire.
 */
export const BrowserEngineImportProfileHandle = TrimmedNonEmptyString.check(Schema.isMaxLength(16));
export type BrowserEngineImportProfileHandle = typeof BrowserEngineImportProfileHandle.Type;

/**
 * Environment-level profile commands for `t3.browser/profiles`. They target a
 * browser profile (an Electron partition the desktop owns), never a session,
 * so they carry no session fence. A profile is always named: the desktop's
 * "every partition" clear is unreachable from here.
 */
export const BrowserEngineProfileCommand = Schema.Union([
  Schema.TaggedStruct("listProfiles", {}),
  Schema.TaggedStruct("clearCookies", { profileId: BrowserProfileId }),
  Schema.TaggedStruct("clearCache", { profileId: BrowserProfileId }),
  Schema.TaggedStruct("listImportSources", {}),
  /**
   * The host asks the user to confirm before reading the source browser;
   * `requester` names the extension in that prompt.
   */
  Schema.TaggedStruct("importCookies", {
    profileId: BrowserProfileId,
    sourceId: BrowserImportSourceId,
    sourceProfile: BrowserEngineImportProfileHandle,
    requester: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
]);
export type BrowserEngineProfileCommand = typeof BrowserEngineProfileCommand.Type;

/** The logical session a guest renders, fenced by server epoch. */
export const BrowserEngineSessionTarget = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  serverEpoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type BrowserEngineSessionTarget = typeof BrowserEngineSessionTarget.Type;

/**
 * Observed page state of a claimed guest. Title rides `navStatus`. The
 * favicon stays server-side: the public sessions projection stores it as a
 * bounded asset and carries only its ref.
 */
export const BrowserEnginePageStatus = Schema.Struct({
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: PreviewZoomFactor,
  appearance: PreviewAppearancePreference,
  audioMuted: Schema.Boolean,
  audible: Schema.Boolean,
  devToolsOpen: Schema.Boolean,
  /** The guest is shown in the host's native picture-in-picture window. */
  pictureInPicture: Schema.Boolean,
  favicon: Schema.NullOr(
    Schema.Struct({
      dataUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(BROWSER_ENGINE_FAVICON_MAX_LENGTH)),
      pageUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH)),
    }),
  ),
});
export type BrowserEnginePageStatus = typeof BrowserEnginePageStatus.Type;

/** Identity comes from the authenticated socket, never from the payload. */
export const BrowserEngineHostRegisterInput = Schema.Struct({});
export type BrowserEngineHostRegisterInput = typeof BrowserEngineHostRegisterInput.Type;

export const BrowserEngineHostStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("registered"),
    hostConnectionId: BrowserEngineHostConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    commandId: BrowserEngineCommandId,
    target: BrowserEngineSessionTarget,
    engineGeneration: BrowserFrameEngineGeneration,
    command: BrowserEngineCommand,
  }),
  Schema.Struct({
    type: Schema.Literal("profile-command"),
    commandId: BrowserEngineCommandId,
    command: BrowserEngineProfileCommand,
  }),
  /**
   * Cookie import is two-phase: after the user confirms, the host answers
   * `confirmed` and waits. The server revalidates the caller's authority and
   * sends `profile-command-proceed`, or `profile-command-cancel` when that
   * authority is gone, the caller gave up or the wait expired. A cancel also
   * dismisses a confirmation that is still showing.
   */
  Schema.Struct({
    type: Schema.Literal("profile-command-proceed"),
    commandId: BrowserEngineCommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("profile-command-cancel"),
    commandId: BrowserEngineCommandId,
  }),
]);
export type BrowserEngineHostStreamEvent = typeof BrowserEngineHostStreamEvent.Type;

const HostFence = {
  hostConnectionId: BrowserEngineHostConnectionId,
  target: BrowserEngineSessionTarget,
  engineGeneration: BrowserFrameEngineGeneration,
};

export const BrowserEngineHostClaimInput = Schema.Struct({
  ...HostFence,
  /** Take over a guest another host owns. Invalidates the previous generation. */
  handoff: Schema.optional(Schema.Boolean),
});
export type BrowserEngineHostClaimInput = typeof BrowserEngineHostClaimInput.Type;

export const BrowserEngineHostReleaseInput = Schema.Struct(HostFence);
export type BrowserEngineHostReleaseInput = typeof BrowserEngineHostReleaseInput.Type;

/**
 * Guest lifecycle outside normal page status. `crashed`: the guest's render
 * process is gone. `recovering`: the host is replacing it (the replacement
 * is released and freshly claimed under its new generation). `exhausted`:
 * recovery gave up; the guest stays dead until the session is reopened.
 * A page status report on the same claim returns the guest to live.
 */
export const BrowserEngineHostLifecycle = Schema.Literals(["crashed", "recovering", "exhausted"]);
export type BrowserEngineHostLifecycle = typeof BrowserEngineHostLifecycle.Type;

export const BrowserEngineHostReportInput = Schema.Union([
  Schema.Struct({ ...HostFence, status: BrowserEnginePageStatus }),
  Schema.Struct({ ...HostFence, lifecycle: BrowserEngineHostLifecycle }),
]);
export type BrowserEngineHostReportInput = typeof BrowserEngineHostReportInput.Type;

export const BrowserEngineCommandRejection = Schema.Literals([
  "stale-generation",
  "session-not-found",
  "not-applicable",
  "failed",
  /** Profile commands: the named profile is not one the host has. */
  "unknown-profile",
  /** The server cancelled the command before it took effect. */
  "cancelled",
]);
export type BrowserEngineCommandRejection = typeof BrowserEngineCommandRejection.Type;

const ProfileNameField = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);
const LabelField = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Built-ins plus the user's own profiles. */
export const BROWSER_ENGINE_PROFILE_LIST_MAX = BROWSER_PROFILE_MAX_COUNT + 2;
const BROWSER_ENGINE_IMPORT_SOURCE_MAX = 16;
const BROWSER_ENGINE_IMPORT_SOURCE_PROFILE_MAX = 32;

/** The profile list as a host reports it: ids and names only, plus the default. */
const BrowserEngineProfileListFields = {
  profiles: Schema.Array(Schema.Struct({ id: BrowserProfileId, name: ProfileNameField })).check(
    Schema.isMaxLength(BROWSER_ENGINE_PROFILE_LIST_MAX),
  ),
  defaultProfileId: BrowserProfileId,
};

/**
 * Answers to profile commands. `profiles` answers `listProfiles`,
 * `import-sources` answers `listImportSources`; `imported`, `declined`
 * (the user refused the host prompt) and `import-failed` answer
 * `importCookies`; `applied` answers a clear.
 */
export const BrowserEngineProfileAnswer = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("profiles"), ...BrowserEngineProfileListFields }),
  Schema.Struct({
    outcome: Schema.Literal("import-sources"),
    sources: Schema.Array(
      Schema.Struct({
        id: BrowserImportSourceId,
        name: LabelField,
        unavailable: Schema.optional(BrowserImportUnavailableReason),
        profiles: Schema.Array(
          Schema.Struct({
            handle: BrowserEngineImportProfileHandle,
            name: LabelField,
            cookieCount: Schema.optional(NonNegativeInt),
          }),
        ).check(Schema.isMaxLength(BROWSER_ENGINE_IMPORT_SOURCE_PROFILE_MAX)),
      }),
    ).check(Schema.isMaxLength(BROWSER_ENGINE_IMPORT_SOURCE_MAX)),
  }),
  Schema.Struct({
    outcome: Schema.Literal("imported"),
    imported: NonNegativeInt,
    skipped: NonNegativeInt,
  }),
  Schema.Struct({ outcome: Schema.Literal("declined") }),
  Schema.Struct({ outcome: Schema.Literal("import-failed"), reason: BrowserImportFailureReason }),
]);
export type BrowserEngineProfileAnswer = typeof BrowserEngineProfileAnswer.Type;

/** `applied` means the guest accepted the command, not that a page finished loading. */
export const BrowserEngineHostCommandResultInput = Schema.Struct({
  hostConnectionId: BrowserEngineHostConnectionId,
  commandId: BrowserEngineCommandId,
  result: Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("applied") }),
    Schema.Struct({
      outcome: Schema.Literal("rejected"),
      reason: BrowserEngineCommandRejection,
    }),
    /** Import only: the user confirmed; the host waits for proceed or cancel. */
    Schema.Struct({ outcome: Schema.Literal("confirmed") }),
    ...BrowserEngineProfileAnswer.members,
  ]),
});
export type BrowserEngineHostCommandResultInput = typeof BrowserEngineHostCommandResultInput.Type;

/**
 * The host's profile list, published once registered and again whenever the
 * desktop's profile settings change. It feeds `t3.browser/profiles`'
 * `changes` stream; the server drops a publication equal to the last one.
 */
export const BrowserEngineHostProfilesInput = Schema.Struct({
  hostConnectionId: BrowserEngineHostConnectionId,
  ...BrowserEngineProfileListFields,
});
export type BrowserEngineHostProfilesInput = typeof BrowserEngineHostProfilesInput.Type;

export class BrowserEngineHostError extends Schema.TaggedError<BrowserEngineHostError>()(
  "BrowserEngineHostError",
  {
    reason: Schema.Literals([
      /** The caller is not the desktop's own authenticated session. */
      "desktop-required",
      /** The host connection is unknown or belongs to another socket. */
      "host-not-registered",
      /** Another host owns the guest and no handoff was requested. */
      "foreign-host",
      "stale-epoch",
      "stale-generation",
      "session-not-found",
    ]),
    message: Schema.String,
  },
) {}
