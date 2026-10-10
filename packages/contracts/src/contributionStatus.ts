import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ForwardCompatibleArray, ProviderSessionId, ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Short status text a producer attaches to a thread, such as a Pi
 * extension's `ctx.ui.setStatus(key, text)`. The server owns these in memory
 * only: they are never persisted and disappear with their producer.
 */
/** Manifest capability for a plugin's `context.proposed.status`; requires `proposedApi: true`. */
export const PLUGIN_STATUS_CAPABILITY = "status";

export const CONTRIBUTION_STATUS_KEY_MAX_LENGTH = 64;
export const CONTRIBUTION_STATUS_TEXT_MAX_LENGTH = 80;
export const CONTRIBUTION_STATUS_TOOLTIP_MAX_LENGTH = 240;
export const CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE = 8;
/**
 * Server-owned limits on a whole snapshot. They bound counts, not bytes: frame
 * size also depends on identifier lengths and on how JSON encodes the text.
 * Clients never enforce them; raising one needs a new capability.
 */
export const CONTRIBUTION_STATUS_MAX_SOURCES_PER_THREAD = 4;
export const CONTRIBUTION_STATUS_MAX_THREADS = 64;
export const CONTRIBUTION_STATUS_MAX_ITEMS = 128;
/**
 * Plugin sources have their own pool beside the limits above, so they never
 * take capacity a provider session would have had: at most 3 plugin sources
 * on a thread (with its provider session, still 4 sources), on at most 32
 * threads, with at most 64 items in all.
 */
export const CONTRIBUTION_STATUS_MAX_PLUGIN_SOURCES_PER_THREAD = 3;
export const CONTRIBUTION_STATUS_MAX_PLUGIN_THREADS = 32;
export const CONTRIBUTION_STATUS_MAX_PLUGIN_ITEMS = 64;

const CONTRIBUTION_STATUS_TONES = ["neutral", "info", "success", "warning", "error"] as const;
const ContributionStatusToneLiteral = Schema.Literals(CONTRIBUTION_STATUS_TONES);
const isContributionStatusTone = Schema.is(ContributionStatusToneLiteral);

/** Tones a newer server adds decode as `neutral` instead of dropping the item. */
export const ContributionStatusTone = Schema.String.pipe(
  Schema.decodeTo(
    ContributionStatusToneLiteral,
    SchemaTransformation.transform<typeof ContributionStatusToneLiteral.Type, string>({
      decode: (tone) => (isContributionStatusTone(tone) ? tone : "neutral"),
      encode: (tone) => tone,
    }),
  ),
);
export type ContributionStatusTone = typeof ContributionStatusTone.Type;

export const ContributionStatusItem = Schema.Struct({
  /** Stable per source; setting an existing key replaces its item. */
  key: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(CONTRIBUTION_STATUS_KEY_MAX_LENGTH),
  ),
  /** Single line of plain text. Producers strip control characters and ANSI styling. */
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(CONTRIBUTION_STATUS_TEXT_MAX_LENGTH),
  ),
  /** Absent means neutral. */
  tone: Schema.optionalKey(ContributionStatusTone),
  tooltip: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(CONTRIBUTION_STATUS_TOOLTIP_MAX_LENGTH)),
  ),
});
export type ContributionStatusItem = typeof ContributionStatusItem.Type;

/**
 * A provider session that set an entry's items. A thread has at most one: a
 * new provider session on the thread takes over the previous one's entry.
 */
const ProviderSessionContributionStatusSource = Schema.Struct({
  kind: Schema.Literal("provider-session"),
  providerSessionId: ProviderSessionId,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});

/**
 * An enabled plugin with the `status` capability. Each plugin owns its own
 * entry on a thread, beside the provider's; `name` is the manifest's display
 * name, never part of the identity.
 */
const PluginContributionStatusSource = Schema.Struct({
  kind: Schema.Literal("plugin"),
  pluginId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
});

/** Who set an entry's items. Clients drop entries of a kind they do not know. */
export const ContributionStatusSource = Schema.Union([
  ProviderSessionContributionStatusSource,
  PluginContributionStatusSource,
]);
export type ContributionStatusSource = typeof ContributionStatusSource.Type;

/**
 * Identity of a source, stable for its lifetime and distinct across a takeover.
 * Renderers key an entry by it and an item by it plus the item key.
 */
export const contributionStatusSourceKey = (source: ContributionStatusSource): string =>
  source.kind === "plugin"
    ? JSON.stringify([source.kind, source.pluginId])
    : JSON.stringify([source.kind, source.providerInstanceId, source.providerSessionId]);

/** One source's items on one thread. Entry identity is the thread plus the source. */
export const ContributionStatusEntry = Schema.Struct({
  threadId: ThreadId,
  source: ContributionStatusSource,
  /** Sorted by key, at most CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE, never empty. */
  items: Schema.Array(ContributionStatusItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE),
  ),
});
export type ContributionStatusEntry = typeof ContributionStatusEntry.Type;

/**
 * Every live status in one environment, ordered by thread id, then provider
 * sources before any other kind, then source key. `subscribeContributionStatus`
 * sends one on subscribe and a full replacement after each change, so a
 * client replaces its copy and never merges. Entries an older client cannot
 * decode, such as a future source kind, are dropped rather than failing the
 * stream.
 */
export const ContributionStatusSnapshot = Schema.Struct({
  entries: ForwardCompatibleArray(ContributionStatusEntry),
});
export type ContributionStatusSnapshot = typeof ContributionStatusSnapshot.Type;
