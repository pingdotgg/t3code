import {
  AuthAccessWriteScope,
  type AuthSessionState,
  type PluginInstallation,
  type PluginInstallationId,
  type PluginInstallationStatus,
  PLUGIN_EVENTS_CAPABILITY,
  pluginInstallationStatus,
} from "@t3tools/contracts";

import { latestPluginCatalogRevision, type PluginCatalogView } from "./plugins.ts";

export type PluginStateTone = "neutral" | "success" | "info" | "warning" | "error";

/** Event delivery for an enabled plugin that declares `events`, shown beside its process state. */
interface PluginEventDeliveryPresentation {
  readonly label: string;
  readonly tone: PluginStateTone;
  readonly detail: string | null;
}

/** What web and mobile show for one installation, and which controls it offers. */
interface PluginInstallationPresentation {
  readonly status: PluginInstallationStatus;
  readonly title: string;
  readonly stateLabel: string;
  readonly tone: PluginStateTone;
  /** The problem, failure reason, or what happens next. */
  readonly detail: string | null;
  /** Null unless the plugin is enabled and declares `events`. */
  readonly delivery: PluginEventDeliveryPresentation | null;
  readonly canReview: boolean;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  /** Process or event delivery waits for `plugins.resume`. */
  readonly canResume: boolean;
}

function directoryName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? directory;
}

function failureCount(failures: number): string {
  return failures === 1 ? "once" : `${failures} times`;
}

function enabledState(
  hostState: PluginInstallation["hostState"],
): Pick<PluginInstallationPresentation, "stateLabel" | "tone" | "detail" | "canResume"> {
  // Absent on an enabled row is a state this client cannot decode, never idle.
  if (hostState === undefined)
    return {
      stateLabel: "Unknown state",
      tone: "warning",
      detail: "The server reported a plugin state this app does not recognize. Update the app.",
      canResume: false,
    };
  switch (hostState._tag) {
    case "idle":
      return {
        stateLabel: "Enabled",
        tone: "success",
        detail: "Starts when first used.",
        canResume: false,
      };
    case "starting":
      return { stateLabel: "Starting", tone: "info", detail: null, canResume: false };
    case "running":
      return { stateLabel: "Running", tone: "success", detail: null, canResume: false };
    case "backoff":
      return {
        stateLabel: "Restarting",
        tone: "warning",
        detail: `Failed ${failureCount(hostState.failures)}: ${hostState.reason} It starts again on next use after a short wait.`,
        canResume: true,
      };
    case "quarantined":
      return {
        stateLabel: "Stopped after repeated failures",
        tone: "error",
        detail: `${hostState.reason} Fix the problem, then resume it.`,
        canResume: true,
      };
    case "incompatible":
      return {
        stateLabel: "Incompatible",
        tone: "error",
        detail: `${hostState.reason} Update the plugin, then resume it.`,
        canResume: true,
      };
  }
}

function deliveryState(
  eventDelivery: PluginInstallation["eventDelivery"],
): PluginEventDeliveryPresentation & { readonly canResume: boolean } {
  // Absent means not reported yet, an older server, or a state this client cannot decode; never healthy.
  if (eventDelivery === undefined)
    return {
      label: "Event delivery unknown",
      tone: "neutral",
      detail: "The server has not reported how event delivery is going.",
      canResume: false,
    };
  switch (eventDelivery._tag) {
    case "active":
      return { label: "Receiving events", tone: "success", detail: null, canResume: false };
    case "retrying":
      return {
        label: "Event delivery retrying",
        tone: "warning",
        detail: `Failed ${failureCount(eventDelivery.failures)}: ${eventDelivery.reason} It tries again shortly, or resume it now.`,
        canResume: true,
      };
    case "quarantined":
      return {
        label: "Event delivery stopped",
        tone: "error",
        detail: `${eventDelivery.failures === 0 ? "An event could not be read." : `Failed ${failureCount(eventDelivery.failures)}.`} ${eventDelivery.reason} Fix the problem, then resume it. No events are skipped.`,
        canResume: true,
      };
  }
}

export function presentPluginInstallation(
  installation: PluginInstallation,
): PluginInstallationPresentation {
  const status = pluginInstallationStatus(installation);
  const title = installation.manifest?.name ?? directoryName(installation.directory);
  // Disable is a way out from every state, so it follows `enabled` rather than status.
  const base = {
    status,
    title,
    delivery: null,
    canReview: status === "needs-consent",
    canEnable: status === "disabled",
    canDisable: installation.enabled,
  };
  switch (status) {
    case "unavailable":
      return {
        ...base,
        stateLabel: "Unavailable",
        tone: "error",
        detail: installation.problem ?? "The plugin directory could not be read.",
        canResume: false,
      };
    case "needs-consent":
      return installation.consent === null
        ? {
            ...base,
            stateLabel: "Needs approval",
            tone: "info",
            detail: "Review its files and capabilities to approve it. Nothing runs until then.",
            canResume: false,
          }
        : {
            ...base,
            stateLabel: "Changed since approval",
            tone: "warning",
            detail:
              "Files in its directory changed after you approved it, so it was stopped. Review the new files to run it again.",
            canResume: false,
          };
    case "disabled":
      return { ...base, stateLabel: "Disabled", tone: "neutral", detail: null, canResume: false };
    case "enabled": {
      const host = enabledState(installation.hostState);
      if (!installation.manifest?.capabilities.includes(PLUGIN_EVENTS_CAPABILITY))
        return { ...base, ...host };
      // Delivery recovers independently of the process: a running plugin can have stopped delivery.
      const { canResume, ...delivery } = deliveryState(installation.eventDelivery);
      return { ...base, ...host, delivery, canResume: host.canResume || canResume };
    }
  }
}

function formatPluginSourceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describePluginSource(source: NonNullable<PluginInstallation["source"]>): string {
  return `${source.files === 1 ? "1 file" : `${source.files} files`}, ${formatPluginSourceSize(source.bytes)}`;
}

/** Shown before consent: plugins are trusted code, not a sandbox. */
export function pluginTrustStatement(environmentLabel: string): string {
  return `Plugins are trusted local code, not a sandbox. Once enabled, this plugin runs as your user account on ${environmentLabel}'s machine, with the same access to its files, programs, and network. Only approve code you trust.`;
}

/** What the digest does and does not promise. */
export const PLUGIN_DIGEST_STATEMENT =
  "Approval covers these exact files. T3 Code checks them when you add, approve, or enable the plugin, when the server starts, and before a call starts the plugin; if a check finds a changed file, it stops the plugin and asks again. A running plugin is not watched, so use Check files again after you change its directory. The digest records what you approved; it does not stop the directory's owner from changing it, and code the plugin loads from outside its directory is not covered.";

/** Shown before removal: an added directory stays, files downloaded from npm do not. */
export function pluginRemovalStatement(environmentLabel: string): string {
  return `T3 Code stops the plugin and forgets your approval, its settings, and its storage. A directory you added stays on ${environmentLabel}'s machine; files T3 Code downloaded from npm are deleted once the plugin has stopped.`;
}

export const PLUGIN_DIRECTORY_GUIDANCE =
  "Add a plugin's build directory, not a git checkout: every file counts, hidden ones included. A plugin must keep its own data outside its directory, or it will need approval again.";

/** Where the directory path lives, worded for whether the server shares this device. */
export function pluginDirectoryLocation(
  environmentLabel: string,
  device: "this-device" | "other-device" | "unknown",
): string {
  const where =
    device === "this-device"
      ? `on ${environmentLabel}'s machine (this device)`
      : device === "other-device"
        ? `on ${environmentLabel}'s machine, not on this device`
        : `on ${environmentLabel}'s machine, which may not be this device`;
  return `An absolute path ${where}. Adding reads its manifest and files; nothing runs until you approve it.`;
}

/**
 * For web and desktop, where a browser or app can pair with an administrative
 * link. Mobile always pairs with standard scopes and shows plugins view-only instead.
 */
export const PLUGIN_MANAGE_ACCESS_REQUIRED =
  "Managing plugins needs administrative access (access:write) to this environment. Pair with an administrative link to add, approve, enable, or remove plugins.";

export const PLUGIN_MANAGE_ACCESS_UNREADABLE =
  "Could not check your access to this environment, so plugin management is off. Try again.";

/** `unreadable`: the session could not be read, so there is no evidence of access:write. */
export type PluginManageAccess = "granted" | "denied" | "pending" | "unreadable";

/**
 * Management needs positive evidence of `access:write` from the session read
 * that is current now. Any server with the plugin catalogue reports its scopes,
 * so a missing list means denied. While a read is failing or in flight, an
 * earlier read grants nothing: it may belong to a previous credential.
 */
export function resolvePluginManageAccess(input: {
  /** The latest successful read, which may predate the current one. */
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): PluginManageAccess {
  if (input.hasError) return "unreadable";
  if (input.isPending) return "pending";
  return input.session?.authenticated && input.session.scopes?.includes(AuthAccessWriteScope)
    ? "granted"
    : "denied";
}

/**
 * Plugin settings save through an administrative RPC, so every session without
 * proven access:write (denied, unreadable, or still checking) sees them read-only.
 */
export function pluginSettingsReadOnly(access: PluginManageAccess): boolean {
  return access !== "granted";
}

/** One environment's catalogue subscription as a screen sees it. */
export type PluginCatalogState =
  | { readonly _tag: "disconnected" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "unsupported" }
  | {
      readonly _tag: "available";
      readonly view: Extract<PluginCatalogView, { readonly _tag: "available" }>;
    };

/**
 * A failed subscription wins over the snapshot it last delivered: that snapshot
 * may be stale, so nothing may be approved or managed from it.
 */
export function resolvePluginCatalogState(input: {
  readonly connected: boolean;
  readonly data: PluginCatalogView | null;
  readonly error: string | null;
}): PluginCatalogState {
  if (!input.connected) return { _tag: "disconnected" };
  if (input.error !== null) return { _tag: "failed", message: input.error };
  if (input.data === null) return { _tag: "loading" };
  if (input.data._tag === "unsupported") return { _tag: "unsupported" };
  return { _tag: "available", view: input.data };
}

/** Controls need access:write and a live, current catalogue. */
export function canManagePlugins(access: PluginManageAccess, catalog: PluginCatalogState): boolean {
  return access === "granted" && catalog._tag === "available";
}

/**
 * Why management controls are off for a lasting reason, or null. A pending check
 * has no notice of its own: screens explain `explainedPluginAccess` here and show
 * `pluginAccessStatus` in a slot that is always laid out.
 */
export function pluginManagementNotice(
  access: PluginManageAccess,
  catalog: PluginCatalogState,
  environmentLabel: string,
): string | null {
  switch (catalog._tag) {
    case "disconnected":
      return `Reconnect ${environmentLabel} to manage its plugins.`;
    case "failed":
      return `Could not load the current plugins from ${environmentLabel}. Retry to manage them.`;
    case "loading":
      return "Loading plugins…";
    case "unsupported":
      return `${environmentLabel} does not support plugins. Update T3 Code there.`;
    case "available":
      switch (access) {
        case "granted":
        case "pending":
          return null;
        case "denied":
          return PLUGIN_MANAGE_ACCESS_REQUIRED;
        case "unreadable":
          return PLUGIN_MANAGE_ACCESS_UNREADABLE;
      }
  }
}

/** Short text for a status slot that is always laid out, shown while access is being checked. */
export const PLUGIN_ACCESS_CHECKING = "Checking access…";

/**
 * Status while the session read that decides access is in flight, or null. The
 * check is brief and repeats on revalidation, so screens show this in a slot that
 * keeps the same size whether or not it has text.
 */
export function pluginAccessStatus(
  access: PluginManageAccess,
  catalog: PluginCatalogState,
): string | null {
  return catalog._tag === "available" && access === "pending" ? PLUGIN_ACCESS_CHECKING : null;
}

/**
 * The access a screen explains: while a re-check is in flight, the last settled
 * one, so the check adds or removes no explanation. Controls follow the live access.
 */
export function explainedPluginAccess(
  access: PluginManageAccess,
  lastSettled: PluginManageAccess | null,
): PluginManageAccess {
  return access === "pending" ? (lastSettled ?? "pending") : access;
}

/**
 * Set on a screen opened by adding: the latest catalogue revision delivered when
 * the add reply arrived, and the reply's installation when the screen has it. A
 * snapshot delivered by then may not list the new plugin yet; only one delivered
 * later can say it is gone.
 */
export interface PluginAddedMarker {
  readonly afterRevision: number;
  readonly installation: PluginInstallation | null;
}

/**
 * Call when `plugins.add` replies. Restarting the catalogue subscription makes
 * the server send its current snapshot even when it equals the last one (a
 * subscription drops repeats), and that delivery is numbered after the marker,
 * so the handoff always ends: listed or missing.
 */
export function startPluginAddHandoff(input: {
  readonly installation: PluginInstallation | null;
  readonly restartCatalog: () => void;
}): PluginAddedMarker {
  const afterRevision = latestPluginCatalogRevision();
  input.restartCatalog();
  return { afterRevision, installation: input.installation };
}

export type PluginDetailState =
  | Exclude<PluginCatalogState, { readonly _tag: "available" }>
  | { readonly _tag: "missing" }
  | { readonly _tag: "found"; readonly installation: PluginInstallation };

/** What an open plugin details or review screen shows. */
export function resolvePluginDetail(input: {
  readonly catalog: PluginCatalogState;
  readonly installationId: PluginInstallationId;
  readonly added: PluginAddedMarker | null;
}): PluginDetailState {
  const { catalog, added } = input;
  if (catalog._tag === "loading" && added?.installation)
    return { _tag: "found", installation: added.installation };
  if (catalog._tag !== "available") return catalog;
  const installation = catalog.view.installations.find(
    (entry) => entry.installationId === input.installationId,
  );
  if (installation) return { _tag: "found", installation };
  if (added !== null && catalog.view.revision <= added.afterRevision)
    return added.installation
      ? { _tag: "found", installation: added.installation }
      : { _tag: "loading" };
  return { _tag: "missing" };
}

type PluginActionStep = () => Promise<
  { readonly error: string | null } | { readonly value: unknown }
>;

export type PluginActionOutcome =
  | { readonly _tag: "done" }
  | { readonly _tag: "refused" }
  | { readonly _tag: "failed"; readonly error: string | null };

/** What a plugin screen may act on right now. */
export interface PluginActionSubject {
  readonly environmentId: string;
  readonly installation: PluginInstallation;
  /** The digest the user acknowledged on this screen, or null. */
  readonly acknowledgedDigest: string | null;
}

/** What an action was started on. An approval also binds the exact files the user reviewed. */
export interface PluginActionTarget {
  readonly environmentId: string;
  readonly installationId: PluginInstallationId;
  readonly approvedDigest?: string;
}

/** Whether an action started on `target` may still dispatch against what the screen shows now. */
function pluginActionStillApplies(
  target: PluginActionTarget,
  current: PluginActionSubject | null,
): boolean {
  if (
    current === null ||
    current.environmentId !== target.environmentId ||
    current.installation.installationId !== target.installationId
  )
    return false;
  return (
    target.approvedDigest === undefined ||
    (current.installation.source?.digest === target.approvedDigest &&
      current.acknowledgedDigest === target.approvedDigest)
  );
}

/**
 * Decides at dispatch time whether a plugin screen may still act. Confirmations
 * and multi-step actions call `run` from callbacks created earlier, so they read
 * this instead of a captured value. The screen calls `set` with what it may act
 * on (null when it may not) on every commit, and `set(null)` when it closes.
 */
export interface PluginActionGate {
  readonly set: (current: PluginActionSubject | null) => void;
  /**
   * Runs steps in order, re-checking `target` against the current subject before
   * each; refuses while another run is going.
   */
  readonly run: (
    target: PluginActionTarget,
    steps: ReadonlyArray<PluginActionStep>,
    onStart?: () => void,
  ) => Promise<PluginActionOutcome>;
}

export function createPluginActionGate(): PluginActionGate {
  let current: PluginActionSubject | null = null;
  let running = false;
  return {
    set: (next) => {
      current = next;
    },
    run: async (target, steps, onStart) => {
      if (running || !pluginActionStillApplies(target, current)) return { _tag: "refused" };
      running = true;
      onStart?.();
      try {
        for (const step of steps) {
          if (!pluginActionStillApplies(target, current)) return { _tag: "refused" };
          const outcome = await step();
          if ("error" in outcome) return { _tag: "failed", error: outcome.error };
        }
        return { _tag: "done" };
      } finally {
        running = false;
      }
    },
  };
}

/** The directory to send to `plugins.add`, or null when nothing may be sent. */
export function pluginAddDirectory(input: {
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly directory: string;
}): string | null {
  const directory = input.directory.trim();
  return input.canManage && !input.busy && directory.length > 0 ? directory : null;
}

/** The server's own message for a failed plugin command. */
export function pluginCommandErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The plugin command failed. Try again.";
}
