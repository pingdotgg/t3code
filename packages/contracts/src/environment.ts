import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  IconColor,
  IconEmoji,
  IconImageDataUrl,
  isMonogramLength,
  LucideIconName,
  MonogramText,
} from "./icon.ts";

/** Wire version for orchestration snapshots, streams, commands, and RPC payloads. */
export const ORCHESTRATION_PROTOCOL_VERSION = 1;
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

/**
 * The kinds a released server accepts as a bare string. Only these have that
 * wire form. A server without `environmentIconOverride` takes them and
 * nothing else, and an older client decodes them from a snapshot. A kind
 * added later travels as the object, because an older peer decodes a string
 * it does not know as null and loses the icon. The list is frozen.
 *
 * `linux` has one gap. The `environmentIcon` capability shipped on
 * 2026-09-02 and `linux` joined the set on 2026-09-06, so 25 nightly builds
 * in between advertise the capability and reject the string, and picking the
 * Linux glyph against one of those fails the whole settings patch. No stable
 * release sits in that window. Dropping `linux` here would instead lock the
 * glyph on every stable server shipping today, which is the larger loss.
 */
export const LEGACY_ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const isLegacyEnvironmentMachineKind = Schema.is(
  Schema.Literals(LEGACY_ENVIRONMENT_MACHINE_KINDS),
);

/**
 * The curated set of machine shapes and OS identities an environment can wear as its icon.
 * Servers detect one from the hardware they run on (`platform.machine`), and
 * the `environmentIcon` server setting lets a user pick one instead. This list
 * grows as detection improves, which is why the wire form above does not.
 */
export const ENVIRONMENT_MACHINE_KINDS = [...LEGACY_ENVIRONMENT_MACHINE_KINDS] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

/**
 * A named glyph: one of the curated ids above, an id the clients add on top
 * of them, or a Lucide id. One field rather than one variant per source,
 * because renderers resolve the curated map first and fall through, so the
 * name alone says which map answers.
 */
export const EnvironmentIconName = LucideIconName;
export type EnvironmentIconName = typeof EnvironmentIconName.Type;

const EnvironmentNamedIcon = Schema.Struct({
  kind: Schema.Literal("icon"),
  name: EnvironmentIconName,
  color: Schema.optionalKey(IconColor),
});
const EnvironmentEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: IconEmoji,
});
const EnvironmentMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: MonogramText,
  color: Schema.optionalKey(IconColor),
});
/**
 * The only setting that holds bytes. It lives in one environment's own
 * `settings.json`, never a map across environments, and the settings stream
 * sends the whole object to every client on change, so one icon per payload
 * is the entire exposure. `IconImageDataUrl` caps the size.
 */
const EnvironmentImageIcon = Schema.Struct({
  kind: Schema.Literal("image"),
  dataUrl: IconImageDataUrl,
});

const EnvironmentIcon = Schema.Union([
  EnvironmentNamedIcon,
  EnvironmentEmojiIcon,
  EnvironmentMonogramIcon,
  EnvironmentImageIcon,
]);
export type EnvironmentIcon = typeof EnvironmentIcon.Type;

/**
 * What a user picked for an environment's icon. Servers that predate the
 * override stored a bare machine kind, and that string form stays on the
 * wire and on disk for a plain pick of one of the seven kinds. That string is
 * what an older server accepts in a patch and what an older client can decode
 * from a snapshot, so the picks that always existed keep working across
 * versions.
 * Anything richer (a color, a name outside the seven, another variant)
 * encodes as the object, which older peers drop to null through
 * `ForwardCompatibleNullable`; the `environmentIconOverride` capability keeps
 * clients from sending an object to a server that would reject it.
 */
export const EnvironmentIconOverride = Schema.Union([EnvironmentMachineKind, EnvironmentIcon]).pipe(
  Schema.decodeTo(
    EnvironmentIcon,
    SchemaTransformation.transform({
      decode: (icon): EnvironmentIcon =>
        typeof icon === "string" ? { kind: "icon", name: icon } : icon,
      encode: (icon) =>
        icon.kind === "icon" &&
        icon.color === undefined &&
        isLegacyEnvironmentMachineKind(icon.name)
          ? icon.name
          : icon,
    }),
  ),
);
export type EnvironmentIconOverride = typeof EnvironmentIconOverride.Type;

/**
 * What a client may write. Projects check the two-character monogram bound in
 * their decider; a settings patch has no such boundary, so it lives here.
 *
 * It stays off `EnvironmentIconOverride` because that schema also decodes
 * snapshots. A peer writing outside the picker, or a later build that widens
 * the bound, can store a longer monogram, and checking it during decode would
 * send that icon through `ForwardCompatibleNullable` to null. The user would
 * get the detected glyph with nothing saying why. Only the write boundary
 * counts, so a snapshot draws what is stored.
 */
export const EnvironmentIconOverrideWrite = EnvironmentIconOverride.check(
  Schema.makeFilter((icon) => icon.kind !== "monogram" || isMonogramLength(icon.text)),
);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  /** Hardware shape detected at startup. Absent when the host gives no usable
      signal (containers, Windows, unknown DMI), on servers that predate it, or
      when a newer server names a kind this build cannot draw. */
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

/**
 * Where a new thread runs: the project's current checkout ("local") or a
 * fresh git worktree ("worktree"). Lives here (not settings.ts) so
 * orchestration contracts can reference it without an import cycle.
 */
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

/**
 * How a new worktree populates git submodules: every nested level, only the
 * ones this repository declares, or not at all.
 */
export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

/** How a server can replace itself with another version when asked over RPC.
    New servers only advertise the stable launcher-backed "boot-service" path;
    "respawn" remains decodable for compatibility with older servers.
    "desktop-app" means the supervising desktop app updated and relaunched
    itself, bringing the server back with it. */
export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

/** What update path a client should offer for a server: one of the RPC
    self-update methods above, or "desktop-managed" when the backend's
    version belongs to the T3 Code desktop app supervising it — updating the
    app on that machine is the only way to update the server. */
export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  /** Missing on older servers, which still accept inline image attachments. */
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  /** Uploaded files may accompany question answers. */
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  /** Missing on servers that only accept image attachments. */
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  /** Server exposes the pull-request list, detail, activity, diff, and mutation APIs. Absent on
      servers from before the pull-request workspace shipped, so clients must not probe them. */
  pullRequests: Schema.optionalKey(Schema.Boolean),
  /** Server understands canonical inline context links plus their message context records.
      Absent on servers from before inline context shipped, which drop the records and forward
      the links as literal text -- so a client must serialize context the legacy way for them. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  /** Server rejects required worktrees instead of falling back to the project checkout. */
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.settle / thread.unsettle commands. Absent on
      pre-settlement servers, so clients treat missing as unsupported and
      never send the commands under version skew. */
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  /** Server evaluates merge and inactivity settlement without a client. */
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  /** Server persists the opt-in for continuing interrupted threads after restarts. */
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  /** Server resolves `projectSettingsOverrides`; older servers ignore the key. */
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.snooze / thread.unsnooze commands. Same
      version-skew contract as threadSettlement. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Server streams themes an environment publishes. Absent on servers from
      before environment themes shipped, which never emit the events -- so a
      client reconnecting to one must drop published themes rather than keep
      showing a set nothing will ever update. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  /** Server streams quota from configured usage-limit sources. Same
      version-skew contract as environmentThemes. */
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Server persists custom model rates and applies them to usage summaries. */
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin / thread.unpin commands. Same
      version-skew contract as threadSettlement. */
  threadPinning: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin.reorder (and orderKey on thread.pin).
      Same version-skew contract as threadSettlement. */
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  /** Server persists manual Active order through thread.active.reorder. */
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.auto-settle.set (per-thread auto-settle off).
      Same version-skew contract as threadSettlement. */
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  /** Server understands regenerateTitle on thread.meta.update. Absent on
      older servers, so clients hide the action instead of sending it. */
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  /** Server supports legacy linkedPullRequest updates through thread.meta.update.
      Independent of threadPullRequests; servers supporting both advertise both. */
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pull-request.link / .unlink, exposes `pullRequests` on
      threads, and routes PullRequestRef.host across projects on the same host. Same
      version-skew contract as threadSettlement. */
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  /** The update path clients should offer for this server. Absent on
      servers that must be relaunched manually (dev checkouts, Windows
      foreground runs, pre-update servers). */
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Server can stream self-update progress before acknowledging the
      restart. Clients fall back to server.updateServer when absent. */
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  /** Server can durably mark running provider turns before a self-update and
      continue them after the replacement process starts. */
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Agent-activity publishes (push notifications and Live Activities)
      currently leave this environment: the publish opt-in is enabled and the
      relay link credentials exist. Clients skip seeding a Live Activity when
      this is false — no update would ever repaint it. Absent on older
      servers, which may still publish, so only an explicit false skips. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  /** Server runs repository clones for new projects in the background and
      streams their progress (`projectClone.*`, `subscribeProjectClones`).
      Absent on older servers, where clients must clone with the blocking
      `sourceControl.cloneRepository` call instead. */
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server detects `platform.machine` and persists the `environmentIcon`
      setting. Older servers drop the key on write, so clients show the
      picker inert rather than offering a choice that would never stick. */
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  /** Server stores `environmentIcon` as an `EnvironmentIconOverride` object.
      `environmentIcon` alone means the server only knows the bare machine
      kind: it would reject an object patch, so clients that see only the
      older flag keep writing the string form and offer only the seven
      legacy kinds. */
  environmentIconOverride: Schema.optionalKey(Schema.Boolean),
  /** The desktop app supervising this server can be driven over RPC:
      server.updateServer runs its check -> download -> relaunch. Absent on
      desktop servers whose app predates the remote trigger, where clients
      must keep telling the user to update the app on that machine. */
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** Missing metadata denotes protocol 1. Bump this for breaking wire changes. */
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  /** Repository browser URL resolved from the server's configured hosting account. */
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
