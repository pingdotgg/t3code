import {
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  resolveActiveProviderPools,
  type ActiveProviderPool,
  type ProviderPoolSettings,
  type ServerProvider,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";

const STATUS_RANK: Record<ServerProvider["status"], number> = {
  ready: 0,
  warning: 1,
  error: 2,
  disabled: 3,
};
const AUTH_RANK: Record<ServerProvider["auth"]["status"], number> = {
  authenticated: 0,
  unknown: 1,
  unauthenticated: 2,
};

const healthRank = (provider: ServerProvider): number =>
  (provider.enabled ? 0 : 1000) +
  (provider.installed ? 0 : 100) +
  STATUS_RANK[provider.status] * 10 +
  AUTH_RANK[provider.auth.status];

const healthiestMember = (members: ReadonlyArray<ServerProvider>): ServerProvider =>
  members.reduce((best, candidate) =>
    healthRank(candidate) < healthRank(best) ? candidate : best,
  );

const intersectByName = <Entry extends { readonly name: string }>(
  lists: ReadonlyArray<ReadonlyArray<Entry>>,
): ReadonlyArray<Entry> => {
  const [first, ...rest] = lists;
  if (first === undefined) return [];
  return first.filter((entry) =>
    rest.every((list) => list.some((candidate) => candidate.name === entry.name)),
  );
};

/** What a dispatch can send for a model: option ids, their choices, and their defaults. */
const optionSignature = (model: ServerProvider["models"][number]): string =>
  JSON.stringify(
    (model.capabilities?.optionDescriptors ?? [])
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((descriptor) =>
        descriptor.type === "select"
          ? [
              descriptor.id,
              descriptor.type,
              descriptor.options.map((choice) => choice.id).toSorted(),
              descriptor.currentValue ??
                descriptor.options.find((choice) => choice.isDefault)?.id ??
                null,
            ]
          : [descriptor.id, descriptor.type, null, descriptor.currentValue ?? null],
      ),
  );

const intersectWorkspaceSnapshots = (
  members: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProviderWorkspaceSnapshot> => {
  const enabledMembers = members.filter((member) => member.enabled);
  const [first, ...rest] = enabledMembers;
  return (first?.workspaceSnapshots ?? []).flatMap((snapshot) => {
    const otherSnapshots = rest.map((member) =>
      member.workspaceSnapshots?.find((candidate) => candidate.cwd === snapshot.cwd),
    );
    if (otherSnapshots.some((candidate) => candidate === undefined)) return [];
    const snapshots = [snapshot, ...otherSnapshots.filter((candidate) => candidate !== undefined)];
    return [
      {
        cwd: snapshot.cwd,
        // A pool snapshot expires as soon as any contributing member's inventory expires.
        checkedAt: snapshots.reduce((oldest, candidate) =>
          Date.parse(candidate.checkedAt) < Date.parse(oldest.checkedAt) ? candidate : oldest,
        ).checkedAt,
        slashCommands: intersectByName(snapshots.map((candidate) => candidate.slashCommands)),
        skills: intersectByName(snapshots.map((candidate) => candidate.skills)),
        ...(snapshots.some((candidate) => candidate.slashCommandsPending)
          ? { slashCommandsPending: true }
          : {}),
        ...(snapshots.every((candidate) => candidate.optionDescriptors === undefined)
          ? {}
          : {
              optionDescriptors: (snapshot.optionDescriptors ?? []).filter((descriptor) =>
                snapshots.every((candidate) =>
                  candidate.optionDescriptors?.some(
                    (other) => JSON.stringify(other) === JSON.stringify(descriptor),
                  ),
                ),
              ),
            }),
      },
    ];
  });
};

function makePoolEntry(
  pool: ActiveProviderPool,
  first: ServerProvider,
  members: ReadonlyArray<ServerProvider>,
): ServerProvider {
  const healthiest = healthiestMember(members);
  // Unavailable placeholders have no catalog and cannot receive failover.
  const catalogMembers = members.filter(isProviderAvailable);
  const slugs = [
    ...new Set(catalogMembers.flatMap((member) => member.models.map((model) => model.slug))),
  ];
  // A failover re-sends the run's options to another member, so a model is
  // shared only when every available member accepts the same options for it.
  const sharedSlugs = new Set(
    slugs.filter((slug) => {
      const signatures = catalogMembers.map((member) => {
        const model = member.models.find((candidate) => candidate.slug === slug);
        return model === undefined ? undefined : optionSignature(model);
      });
      return signatures.every(
        (signature) => signature !== undefined && signature === signatures[0],
      );
    }),
  );
  const models = catalogMembers
    .flatMap((member) => member.models)
    .filter((model, index, all) => {
      if (!sharedSlugs.has(model.slug)) return false;
      return all.findIndex((candidate) => candidate.slug === model.slug) === index;
    });
  const groupKeys = new Set(members.map((member) => member.continuation?.groupKey ?? null));
  const sharedGroupKey = groupKeys.size === 1 ? (first.continuation?.groupKey ?? null) : null;
  return {
    instanceId: pool.instanceId,
    driver: pool.driver,
    displayName: PROVIDER_DISPLAY_NAMES[pool.driver] ?? pool.driver,
    badgeLabel: "Pool",
    ...(sharedGroupKey === null ? {} : { continuation: { groupKey: sharedGroupKey } }),
    ...(first.showInteractionModeToggle === undefined
      ? {}
      : { showInteractionModeToggle: first.showInteractionModeToggle }),
    ...(first.reportsContextWindow === undefined
      ? {}
      : { reportsContextWindow: first.reportsContextWindow }),
    ...(first.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: first.supportedRuntimeModes }),
    ...(first.supportsConversationRollback === undefined
      ? {}
      : { supportsConversationRollback: first.supportsConversationRollback }),
    // Text generation and source-control writers call adapters directly, which a
    // pool cannot answer; keeping it false hides the pool from those pickers.
    supportsTextGeneration: false,
    enabled: true,
    installed: healthiest.installed,
    version: healthiest.version,
    status: healthiest.status,
    auth: healthiest.auth,
    checkedAt: healthiest.checkedAt,
    models,
    slashCommands: intersectByName(catalogMembers.map((member) => member.slashCommands)),
    skills: intersectByName(catalogMembers.map((member) => member.skills)),
    workspaceSnapshots: intersectWorkspaceSnapshots(catalogMembers),
    pool: {
      role: "pool",
      memberInstanceIds: pool.memberInstanceIds,
      droppedModels: slugs.filter((slug) => !sharedSlugs.has(slug)),
    },
  };
}

/**
 * The published provider list: every real instance, plus one virtual entry per
 * configured pool, including disabled accounts so saved member selections still route
 * through the pool. Eligibility is checked at dispatch.
 */
export function withProviderPools(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerPools: ProviderPoolSettings;
}): ReadonlyArray<ServerProvider> {
  const pools = resolveActiveProviderPools({
    providerPools: input.providerPools,
    instances: input.providers,
  });
  if (pools.length === 0) return input.providers;
  const poolByMember = new Map(
    pools.flatMap((pool) =>
      pool.memberInstanceIds.map((memberId) => [memberId, pool.instanceId] as const),
    ),
  );
  const byId = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  return [
    ...input.providers.map((provider) => {
      const poolInstanceId = poolByMember.get(provider.instanceId);
      return poolInstanceId === undefined
        ? provider
        : { ...provider, pool: { role: "member" as const, poolInstanceId } };
    }),
    ...pools.flatMap((pool) => {
      const members = pool.memberInstanceIds.flatMap((memberId) => {
        const member = byId.get(memberId);
        return member === undefined ? [] : [member];
      });
      const [first] = members;
      return first === undefined ? [] : [makePoolEntry(pool, first, members)];
    }),
  ];
}
