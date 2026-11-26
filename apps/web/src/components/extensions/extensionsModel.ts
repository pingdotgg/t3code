// Fork: Kaluwa's Extensions page. Pure derivations over the extensions list.
import type {
  ExtensionHealth,
  ExtensionKind,
  ExtensionMcpTransport,
  ExtensionSkillLibraryCopy,
  ExtensionSkillSource,
  ExtensionsListResult,
  ExtensionsMutation,
  ExtensionsSubscription,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const EXTENSION_KINDS = [
  "mcp",
  "plugin",
  "skill",
] as const satisfies readonly ExtensionKind[];

/** One extension as one subscription has it. */
export interface ExtensionPresence {
  readonly health: ExtensionHealth;
  readonly detail: string | null;
  readonly enabled: boolean;
  readonly secretNames: readonly string[];
  readonly managedElsewhere: boolean;
  readonly skillSource: ExtensionSkillSource | null;
  /** For a subscription's own skill: whether the library has that name too, and the same files. */
  readonly libraryCopy: ExtensionSkillLibraryCopy;
  /** What tells two setups of the same name apart: the target, the version or the copy. */
  readonly signature: string;
  /** The target, version or path, as shown beside the subscription. */
  readonly location: string;
}

/** One extension name across every subscription. */
export interface ExtensionEntry {
  readonly key: string;
  readonly kind: ExtensionKind;
  /** The server name, the plugin's `name@marketplace` or the skill name. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly transport: ExtensionMcpTransport | null;
  readonly target: string | null;
  readonly marketplace: string | null;
  readonly version: string | null;
  readonly inLibrary: boolean;
  readonly presence: ReadonlyMap<ProviderInstanceId, ExtensionPresence>;
}

function entryKey(kind: ExtensionKind, id: string) {
  return `${kind}:${id}`;
}

export function pendingKey(instanceId: ProviderInstanceId, key: string) {
  return `${instanceId}|${key}`;
}

export function supportsKind(subscription: ExtensionsSubscription, kind: ExtensionKind) {
  return kind === "mcp"
    ? subscription.capabilities.mcp
    : kind === "plugin"
      ? subscription.capabilities.plugins
      : subscription.capabilities.skills;
}

/** A turned-off extension reads as off even when the last check saw it working. */
export function presenceHealth(presence: ExtensionPresence): ExtensionHealth {
  return presence.enabled ? presence.health : "disabled";
}

/**
 * The health to draw. Nothing checks plugins or skills one by one, so one that is there and not
 * reported broken counts as working; only an MCP server can be "not checked".
 */
export function shownHealth(kind: ExtensionKind, presence: ExtensionPresence): ExtensionHealth {
  const health = presenceHealth(presence);
  return health === "unknown" && kind !== "mcp" ? "ok" : health;
}

export function needsAttention(health: ExtensionHealth) {
  return health === "failing" || health === "needsAuth";
}

const HEALTH_ORDER: Record<ExtensionHealth, number> = {
  failing: 0,
  needsAuth: 1,
  unknown: 2,
  ok: 3,
  disabled: 4,
};

export function compareHealth(left: ExtensionHealth, right: ExtensionHealth) {
  return HEALTH_ORDER[left] - HEALTH_ORDER[right];
}

/**
 * A fast list reports MCP health as `unknown`. Keeps the structure of the newer list and fills
 * that health in from the other one, for servers whose setup has not changed since.
 */
export function mergeExtensionLists(
  left: ExtensionsListResult | null,
  right: ExtensionsListResult | null,
): ExtensionsListResult | null {
  if (left === null || right === null) return left ?? right;
  const [base, other] = left.checkedAt >= right.checkedAt ? [left, right] : [right, left];
  const known = new Map(
    other.subscriptions.flatMap((subscription) =>
      subscription.mcpServers
        .filter((server) => server.health !== "unknown")
        .map((server) => [`${subscription.instanceId}\n${server.name}`, server] as const),
    ),
  );
  if (known.size === 0) return base;
  return {
    ...base,
    healthChecked: base.healthChecked || other.healthChecked,
    subscriptions: base.subscriptions.map((subscription) => ({
      ...subscription,
      mcpServers: subscription.mcpServers.map((server) => {
        if (server.health !== "unknown") return server;
        const previous = known.get(`${subscription.instanceId}\n${server.name}`);
        return previous !== undefined &&
          previous.target === server.target &&
          previous.transport === server.transport &&
          previous.enabled === server.enabled
          ? { ...server, health: previous.health, detail: previous.detail }
          : server;
      }),
    })),
  };
}

/** Drops what a past check said about one server, once a change makes it out of date. */
export function forgetMcpHealth(
  list: ExtensionsListResult,
  instanceIds: readonly ProviderInstanceId[],
  name: string,
): ExtensionsListResult {
  return {
    ...list,
    subscriptions: list.subscriptions.map((subscription) =>
      instanceIds.includes(subscription.instanceId)
        ? {
            ...subscription,
            mcpServers: subscription.mcpServers.map((server) =>
              server.name === name ? { ...server, health: "unknown", detail: null } : server,
            ),
          }
        : subscription,
    ),
  };
}

/** The MCP server and subscriptions whose health a mutation makes out of date. */
export function mutationStaleMcpHealth(
  mutation: ExtensionsMutation,
): { readonly instanceIds: readonly ProviderInstanceId[]; readonly name: string } | null {
  switch (mutation._tag) {
    case "McpAdd":
      return { instanceIds: mutation.instanceIds, name: mutation.name };
    case "McpCopy":
      return { instanceIds: mutation.toInstanceIds, name: mutation.name };
    case "McpSetEnabled":
    case "McpSignIn":
      return { instanceIds: [mutation.instanceId], name: mutation.name };
    default:
      return null;
  }
}

interface EntryDraft {
  kind: ExtensionKind;
  id: string;
  name: string;
  description: string | null;
  transport: ExtensionMcpTransport | null;
  target: string | null;
  marketplace: string | null;
  version: string | null;
  inLibrary: boolean;
  presence: Map<ProviderInstanceId, ExtensionPresence>;
}

/** Every extension, one entry per kind and name, sorted by name. */
export function buildExtensionEntries(list: ExtensionsListResult): readonly ExtensionEntry[] {
  const drafts = new Map<string, EntryDraft>();
  const draft = (kind: ExtensionKind, id: string, name: string) => {
    const key = entryKey(kind, id);
    const existing = drafts.get(key);
    if (existing) return existing;
    const created: EntryDraft = {
      kind,
      id,
      name,
      description: null,
      transport: null,
      target: null,
      marketplace: null,
      version: null,
      inLibrary: false,
      presence: new Map(),
    };
    drafts.set(key, created);
    return created;
  };

  for (const skill of list.library.skills) {
    const entry = draft("skill", skill.name, skill.name);
    entry.inLibrary = true;
    entry.description = skill.description;
  }
  for (const subscription of list.subscriptions) {
    for (const server of subscription.mcpServers) {
      const entry = draft("mcp", server.name, server.name);
      entry.transport ??= server.transport;
      entry.target ??= server.target;
      entry.presence.set(subscription.instanceId, {
        health: server.health,
        detail: server.detail,
        enabled: server.enabled,
        secretNames: server.secretNames,
        managedElsewhere: server.managedElsewhere,
        skillSource: null,
        libraryCopy: "none",
        signature: `${server.transport} ${server.target}`,
        location: server.target,
      });
    }
    for (const plugin of subscription.plugins) {
      const entry = draft("plugin", plugin.id, plugin.name);
      entry.description ??= plugin.description;
      entry.marketplace ??= plugin.marketplace;
      entry.version ??= plugin.version;
      entry.presence.set(subscription.instanceId, {
        health: plugin.health,
        detail: plugin.detail,
        enabled: plugin.enabled,
        secretNames: [],
        managedElsewhere: false,
        skillSource: null,
        libraryCopy: "none",
        signature: plugin.version ?? "",
        location: plugin.version ?? "",
      });
    }
    for (const skill of subscription.skills) {
      // A dead link is not a skill; it is listed with its subscription's broken links instead.
      if (skill.brokenLink) continue;
      const entry = draft("skill", skill.name, skill.name);
      entry.description ??= skill.description;
      entry.presence.set(subscription.instanceId, {
        health: skill.health,
        detail: skill.detail,
        enabled: true,
        secretNames: [],
        managedElsewhere: false,
        skillSource: skill.source,
        libraryCopy: skill.source === "local" ? skill.libraryCopy : "none",
        // Every local copy is its own; library links all point at one.
        signature: skill.source === "library" ? "library" : `local ${subscription.instanceId}`,
        location: skill.path,
      });
    }
  }
  return [...drafts.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The same name set up differently: another target, another version, or separate skill copies. */
export function entryDiffers(entry: ExtensionEntry) {
  const signatures = new Set<string>();
  for (const presence of entry.presence.values()) {
    if (entry.kind === "plugin" && presence.signature === "") continue;
    signatures.add(presence.signature);
  }
  if (entry.kind === "skill" && entry.inLibrary && signatures.size === 1) {
    return !signatures.has("library");
  }
  return signatures.size > 1;
}

export function entryNeedsAttention(entry: ExtensionEntry) {
  for (const presence of entry.presence.values()) {
    if (needsAttention(presenceHealth(presence))) return true;
  }
  return false;
}

/** Whether another subscription can get this one: a server to copy, a plugin, a library skill. */
export function entryCanCopy(entry: ExtensionEntry) {
  if (entry.kind === "plugin") return true;
  if (entry.kind === "skill") return entry.inLibrary;
  for (const presence of entry.presence.values()) {
    if (!presence.managedElsewhere) return true;
  }
  return false;
}

export function supportingSubscriptions(
  subscriptions: readonly ExtensionsSubscription[],
  kind: ExtensionKind,
) {
  return subscriptions.filter((subscription) => supportsKind(subscription, kind));
}

/** Subscriptions that could have this extension and don't. */
export function entryMissingIn(
  entry: ExtensionEntry,
  subscriptions: readonly ExtensionsSubscription[],
): readonly ExtensionsSubscription[] {
  if (!entryCanCopy(entry)) return [];
  return supportingSubscriptions(subscriptions, entry.kind).filter(
    (subscription) => !entry.presence.has(subscription.instanceId),
  );
}

export function entryHasGap(
  entry: ExtensionEntry,
  subscriptions: readonly ExtensionsSubscription[],
) {
  return (
    (entry.presence.size > 0 || entry.inLibrary) && entryMissingIn(entry, subscriptions).length > 0
  );
}

/** The change that gives `toInstanceIds` this extension, or null when nothing can. */
export function copyMutation(
  entry: ExtensionEntry,
  toInstanceIds: readonly ProviderInstanceId[],
): ExtensionsMutation | null {
  if (toInstanceIds.length === 0 || !entryCanCopy(entry)) return null;
  if (entry.kind === "plugin") {
    return { _tag: "PluginInstall", instanceIds: toInstanceIds, pluginId: entry.id };
  }
  if (entry.kind === "skill") {
    return { _tag: "SkillLink", instanceIds: toInstanceIds, name: entry.id };
  }
  // Copy from the setup most likely to work.
  const source = [...entry.presence.entries()]
    .filter(([, presence]) => !presence.managedElsewhere)
    .sort(([, left], [, right]) => compareHealth(right.health, left.health))[0];
  return source === undefined
    ? null
    : { _tag: "McpCopy", fromInstanceId: source[0], toInstanceIds, name: entry.id };
}

export interface ExtensionAttentionItem {
  readonly entry: ExtensionEntry;
  readonly instanceId: ProviderInstanceId;
  readonly health: ExtensionHealth;
  readonly detail: string | null;
}

/** What needs a sign-in or is failing on one subscription, failures first. */
export function subscriptionAttention(
  entries: readonly ExtensionEntry[],
  instanceId: ProviderInstanceId,
): readonly ExtensionAttentionItem[] {
  return entries
    .flatMap((entry) => {
      const presence = entry.presence.get(instanceId);
      if (presence === undefined) return [];
      const health = presenceHealth(presence);
      return needsAttention(health) ? [{ entry, instanceId, health, detail: presence.detail }] : [];
    })
    .sort((left, right) => compareHealth(left.health, right.health));
}

/** Skill links whose target is gone. However many there are, they are one thing to clean up. */
export function brokenSkillLinks(subscription: ExtensionsSubscription) {
  return subscription.skills.filter((skill) => skill.brokenLink);
}

/** The subscription's skills that are really there. */
export function workingSkillCount(subscription: ExtensionsSubscription) {
  return subscription.skills.length - brokenSkillLinks(subscription).length;
}

export const BROKEN_LINKS_PENDING_KEY = "skill-broken-links";

export interface ExtensionHealthSummary {
  readonly failing: number;
  /** Sign-ins, unreadable parts, and the broken links counted once. */
  readonly warnings: number;
}

export function subscriptionHealthSummary(
  subscription: ExtensionsSubscription,
): ExtensionHealthSummary {
  const healths = [
    ...subscription.mcpServers.map((server) => (server.enabled ? server.health : "disabled")),
    ...subscription.plugins.map((plugin) => (plugin.enabled ? plugin.health : "disabled")),
    ...subscription.skills.filter((skill) => !skill.brokenLink).map((skill) => skill.health),
  ];
  return {
    failing: healths.filter((health) => health === "failing").length,
    warnings:
      healths.filter((health) => health === "needsAuth").length +
      subscription.issues.length +
      (brokenSkillLinks(subscription).length > 0 ? 1 : 0),
  };
}

/**
 * How many things want attention over every subscription: each failing or signed-out extension,
 * and each subscription's broken links as one.
 */
export function attentionCount(list: ExtensionsListResult) {
  return list.subscriptions.reduce((total, subscription) => {
    const summary = subscriptionHealthSummary(subscription);
    return total + summary.failing + summary.warnings - subscription.issues.length;
  }, 0);
}

export function listNeedsAttention(list: ExtensionsListResult | null) {
  return (
    list !== null &&
    (attentionCount(list) > 0 ||
      list.subscriptions.some((subscription) => subscription.issues.length > 0))
  );
}

export function entryMatchesSearch(entry: ExtensionEntry, query: string) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [entry.name, entry.description, entry.target, entry.marketplace].some(
    (value) => value !== null && value.toLowerCase().includes(needle),
  );
}

/** The subscriptions and extension a mutation touches, for per-row pending state. */
export function mutationPendingKeys(mutation: ExtensionsMutation): readonly string[] {
  switch (mutation._tag) {
    case "McpAdd":
      return mutation.instanceIds.map((id) => pendingKey(id, entryKey("mcp", mutation.name)));
    case "McpCopy":
      return mutation.toInstanceIds.map((id) => pendingKey(id, entryKey("mcp", mutation.name)));
    case "McpRemove":
    case "McpSetEnabled":
    case "McpSignIn":
      return [pendingKey(mutation.instanceId, entryKey("mcp", mutation.name))];
    case "PluginInstall":
      return mutation.instanceIds.map((id) =>
        pendingKey(id, entryKey("plugin", mutation.pluginId)),
      );
    case "PluginSetEnabled":
    case "PluginUninstall":
      return [pendingKey(mutation.instanceId, entryKey("plugin", mutation.pluginId))];
    case "SkillLink":
      return mutation.instanceIds.map((id) => pendingKey(id, entryKey("skill", mutation.name)));
    case "SkillUnlink":
    case "SkillMoveToLibrary":
    case "SkillUseLibraryCopy":
      return [pendingKey(mutation.instanceId, entryKey("skill", mutation.name))];
    case "SkillRemoveBrokenLinks":
      return [pendingKey(mutation.instanceId, BROKEN_LINKS_PENDING_KEY)];
  }
}

/** The extension a mutation is about, or null when it is about a whole subscription. */
export function mutationSubjectName(mutation: ExtensionsMutation): string | null {
  if ("pluginId" in mutation) return mutation.pluginId.split("@")[0]!;
  return "name" in mutation ? mutation.name : null;
}
