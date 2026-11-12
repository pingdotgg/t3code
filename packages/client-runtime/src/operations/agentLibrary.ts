import {
  agentSkillHasResources,
  agentSkillTieKey,
  isAgentSkillStub,
  mergeAgentLibraries,
  withoutAgentSkillTransportFields,
  WS_METHODS,
  type AgentLibrary,
  type AgentLibraryOperation,
  type AgentSkill,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type McpGatewayProfile,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";

type AgentLibraryInput = Parameters<typeof mergeAgentLibraries>[0][number];

export type AgentLibraryCapabilities = Pick<
  ExecutionEnvironmentCapabilities,
  | "agentLibrarySync"
  | "agentSkillsSync"
  | "agentSkillResources"
  | "agentSkillBodiesOnDemand"
  | "agentLibraryMutations"
>;

export interface AgentLibrarySource {
  readonly environmentId: EnvironmentId;
  readonly library: AgentLibraryInput;
  readonly capabilities: AgentLibraryCapabilities | undefined;
  /** Connected now: it can take a patch and serve skill bodies. Cached libraries only contribute. */
  readonly live: boolean;
}

export interface AgentLibraryPatch {
  readonly mcpGatewayProfiles: ReadonlyArray<McpGatewayProfile>;
  readonly mcpGatewayProfileDeletedAt: Readonly<Record<string, string>>;
  readonly agentSkills?: ReadonlyArray<AgentSkill>;
  readonly agentSkillDeletedAt?: Readonly<Record<string, string>>;
}

export interface AgentLibrarySyncTarget {
  readonly environmentId: EnvironmentId;
  readonly patch: AgentLibraryPatch;
  /** Skills the target already holds; absent when it cannot hold skills at all. */
  readonly heldSkillIds?: ReadonlyArray<string>;
}

export interface AgentLibrarySyncPlan {
  readonly library: AgentLibrary;
  /** Only targets missing something; skills in a patch may still be stubs until filled. */
  readonly targets: ReadonlyArray<AgentLibrarySyncTarget>;
  /** Where to fetch the bodies of stub skills the patches carry. */
  readonly fetches: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly skillIds: ReadonlyArray<string>;
  }>;
}

const syncs = (source: AgentLibrarySource) => source.capabilities?.agentLibrarySync === true;

/** A live environment serving this exact skill version, preferring a stable choice across runs. */
function skillHolder(sources: ReadonlyArray<AgentLibrarySource>, skill: AgentSkill) {
  const key = agentSkillTieKey(skill);
  return sources
    .filter(
      (source) =>
        source.live &&
        source.capabilities?.agentSkillBodiesOnDemand === true &&
        source.library.agentSkills?.some(
          (held) => held.skillId === skill.skillId && agentSkillTieKey(held) === key,
        ),
    )
    .map((source) => source.environmentId)
    .sort()[0];
}

/** Library sources from client environment state; only connected ones can be written. */
export function agentLibrarySources(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
    readonly serverConfig?: {
      readonly settings: AgentLibraryInput;
      readonly environment: { readonly capabilities: AgentLibraryCapabilities };
    } | null;
  }>,
): ReadonlyArray<AgentLibrarySource> {
  return environments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            library: environment.serverConfig.settings,
            capabilities: environment.serverConfig.environment.capabilities,
            live: environment.connection.phase === "connected",
          },
        ]
      : [],
  );
}

/**
 * Full skills for `skillIds` in `library`, fetching stub bodies from a connected environment that
 * holds that version. Skills no reachable environment can serve are left out.
 */
export async function loadAgentSkills(
  sources: ReadonlyArray<AgentLibrarySource>,
  library: Pick<AgentLibrary, "agentSkills">,
  skillIds: ReadonlyArray<string>,
  fetchSkills: AgentLibrarySyncIo["fetchSkills"],
): Promise<ReadonlyArray<AgentSkill>> {
  const wanted = library.agentSkills.filter((skill) => skillIds.includes(skill.skillId));
  const groups = new Map<EnvironmentId, string[]>();
  for (const skill of wanted) {
    if (!isAgentSkillStub(skill)) continue;
    const holder =
      skillHolder(sources, skill) ??
      sources.find(
        (source) =>
          source.live &&
          source.capabilities?.agentSkillBodiesOnDemand === true &&
          source.library.agentSkills?.some((held) => held.skillId === skill.skillId),
      )?.environmentId;
    if (holder !== undefined) groups.set(holder, [...(groups.get(holder) ?? []), skill.skillId]);
  }
  const fetched = (
    await Promise.all(
      [...groups].map(([environmentId, ids]) =>
        fetchSkills(environmentId, ids).catch((): ReadonlyArray<AgentSkill> => []),
      ),
    )
  ).flat();
  return wanted.flatMap((skill) => {
    if (!isAgentSkillStub(skill)) return [skill];
    const full = fetched.find(
      (candidate) => candidate.skillId === skill.skillId && !isAgentSkillStub(candidate),
    );
    return full ? [withoutAgentSkillTransportFields(full)] : [];
  });
}

/** The fields a target keeps; anything else it strips and would read as a perpetual difference. */
function profileForTarget(profile: McpGatewayProfile, capabilities: AgentLibraryCapabilities) {
  const { skillIds, iconId, tags, ...rest } = profile;
  return {
    ...rest,
    ...(capabilities.agentSkillsSync === true && skillIds !== undefined ? { skillIds } : {}),
    ...(capabilities.agentLibraryMutations === true && iconId !== undefined ? { iconId } : {}),
    ...(capabilities.agentLibraryMutations === true && tags !== undefined ? { tags } : {}),
  };
}

/**
 * Older servers keep their stored name on an updatedAt tie, so a merge's case-clash rename
 * ("doug (2)") would be re-sent forever; they get the name the winning version was saved with.
 */
function withoutMergeRename(
  sources: ReadonlyArray<AgentLibrarySource>,
  profile: McpGatewayProfile,
) {
  for (const source of sources) {
    const saved = source.library.mcpGatewayProfiles.find(
      (item) => item.profileId === profile.profileId && item.updatedAt === profile.updatedAt,
    );
    if (
      saved &&
      saved.name !== profile.name &&
      /^ \(\d+\)$/.test(profile.name.slice(saved.name.length)) &&
      profile.name.startsWith(saved.name)
    )
      return { ...profile, name: saved.name };
  }
  return profile;
}

const newerDeletions = (
  merged: Readonly<Record<string, string>>,
  target: Readonly<Record<string, string>> | undefined,
) => Object.fromEntries(Object.entries(merged).filter(([id, at]) => at > (target?.[id] ?? "")));

/**
 * Per-target patches carrying only what each target lacks or holds older. A stub winner is
 * fetched in full from a live environment holding that exact version, or left for a later pass.
 */
export function planAgentLibrarySync(
  sources: ReadonlyArray<AgentLibrarySource>,
  options: { readonly targets?: ReadonlyArray<string> } = {},
): AgentLibrarySyncPlan {
  const syncing = sources.filter(syncs);
  const library = mergeAgentLibraries(syncing.map((source) => source.library));
  const holders = new Map<string, EnvironmentId>();
  const targets = syncing.flatMap((target) => {
    if (!target.live || target.capabilities === undefined) return [];
    if (options.targets && !options.targets.includes(target.environmentId)) return [];
    const capabilities = target.capabilities;
    const own = target.library;
    const mcpGatewayProfiles = library.mcpGatewayProfiles.flatMap((merged) => {
      const profile =
        capabilities.agentLibraryMutations === true ? merged : withoutMergeRename(syncing, merged);
      const held = own.mcpGatewayProfiles.find((item) => item.profileId === profile.profileId);
      return held === undefined ||
        JSON.stringify(profileForTarget(held, capabilities)) !==
          JSON.stringify(profileForTarget(profile, capabilities))
        ? [profile]
        : [];
    });
    const mcpGatewayProfileDeletedAt = newerDeletions(
      library.mcpGatewayProfileDeletedAt,
      own.mcpGatewayProfileDeletedAt,
    );
    const skillsSupported = capabilities.agentSkillsSync === true;
    const agentSkills = skillsSupported
      ? library.agentSkills.filter((skill) => {
          if (agentSkillHasResources(skill) && capabilities.agentSkillResources !== true)
            return false;
          const held = own.agentSkills?.find((item) => item.skillId === skill.skillId);
          if (held && agentSkillTieKey(held) === agentSkillTieKey(skill)) return false;
          if (!isAgentSkillStub(skill)) return true;
          const holder = skillHolder(syncing, skill);
          if (holder === undefined) return false;
          holders.set(skill.skillId, holder);
          return true;
        })
      : [];
    const agentSkillDeletedAt = skillsSupported
      ? newerDeletions(library.agentSkillDeletedAt, own.agentSkillDeletedAt)
      : {};
    if (
      mcpGatewayProfiles.length === 0 &&
      Object.keys(mcpGatewayProfileDeletedAt).length === 0 &&
      agentSkills.length === 0 &&
      Object.keys(agentSkillDeletedAt).length === 0
    )
      return [];
    const patch: AgentLibraryPatch = {
      mcpGatewayProfiles: mcpGatewayProfiles.map((profile) =>
        profileForTarget(profile, capabilities),
      ),
      mcpGatewayProfileDeletedAt,
      ...(skillsSupported ? { agentSkills, agentSkillDeletedAt } : {}),
    };
    return [
      {
        environmentId: target.environmentId,
        patch,
        ...(skillsSupported
          ? { heldSkillIds: (own.agentSkills ?? []).map((skill) => skill.skillId) }
          : {}),
      },
    ];
  });
  const fetches = new Map<EnvironmentId, string[]>();
  for (const [skillId, environmentId] of holders)
    fetches.set(environmentId, [...(fetches.get(environmentId) ?? []), skillId]);
  return {
    library,
    targets,
    fetches: [...fetches].map(([environmentId, skillIds]) => ({ environmentId, skillIds })),
  };
}

/** Replaces stubs with the fetched version they name; a stub without its body is left out. */
export function withAgentSkillBodies(
  patch: AgentLibraryPatch,
  fetched: ReadonlyArray<AgentSkill>,
): AgentLibraryPatch {
  if (!patch.agentSkills?.some(isAgentSkillStub)) return patch;
  return {
    ...patch,
    agentSkills: patch.agentSkills.flatMap((skill) => {
      if (!isAgentSkillStub(skill)) return [skill];
      const key = agentSkillTieKey(skill);
      const full = fetched.find(
        (candidate) =>
          candidate.skillId === skill.skillId &&
          !isAgentSkillStub(candidate) &&
          agentSkillTieKey(candidate) === key,
      );
      return full ? [withoutAgentSkillTransportFields(full)] : [];
    }),
  };
}

/** Names of library skills assigned to `profile` that a target holding `available` lacks. */
export function missingAgentSkills(
  library: Pick<AgentLibrary, "agentSkills">,
  profile: Pick<McpGatewayProfile, "skillIds">,
  available: ReadonlySet<string>,
): ReadonlyArray<string> {
  return (profile.skillIds ?? []).flatMap((skillId) => {
    const skill = library.agentSkills.find((item) => item.skillId === skillId);
    return skill && !available.has(skillId) ? [skill.name] : [];
  });
}

/**
 * Fills stub bodies, then holds back agents whose assigned skills the target would still lack,
 * so no machine stores an agent that silently runs without one. They follow on a later pass.
 */
export function completeAgentLibraryPatch(
  library: Pick<AgentLibrary, "agentSkills">,
  target: AgentLibrarySyncTarget,
  fetched: ReadonlyArray<AgentSkill>,
): { readonly patch: AgentLibraryPatch; readonly complete: boolean } {
  const patch = withAgentSkillBodies(target.patch, fetched);
  // A planned body that could not be fetched; skills nobody live serves were never planned.
  const complete = patch.agentSkills?.length === target.patch.agentSkills?.length;
  if (target.heldSkillIds === undefined) return { patch, complete };
  const available = new Set([
    ...target.heldSkillIds,
    ...(patch.agentSkills ?? []).map((skill) => skill.skillId),
  ]);
  const mcpGatewayProfiles = patch.mcpGatewayProfiles.filter(
    (profile) => missingAgentSkills(library, profile, available).length === 0,
  );
  return { patch: { ...patch, mcpGatewayProfiles }, complete };
}

const isEmptyPatch = (patch: AgentLibraryPatch) =>
  patch.mcpGatewayProfiles.length === 0 &&
  Object.keys(patch.mcpGatewayProfileDeletedAt).length === 0 &&
  (patch.agentSkills ?? []).length === 0 &&
  Object.keys(patch.agentSkillDeletedAt ?? {}).length === 0;

export interface AgentLibrarySyncIo {
  readonly fetchSkills: (
    environmentId: EnvironmentId,
    skillIds: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<AgentSkill>>;
  /** Resolves whether the target accepted the patch. */
  readonly replicate: (environmentId: EnvironmentId, patch: AgentLibraryPatch) => Promise<boolean>;
}

/**
 * Runs a plan from React clients. A failed fetch defers those skills, and agents assigned them,
 * to the next pass and reports false, as a rejected patch does.
 */
export async function runAgentLibrarySync(
  plan: AgentLibrarySyncPlan,
  io: AgentLibrarySyncIo,
): Promise<boolean> {
  const fetched = (
    await Promise.all(
      plan.fetches.map(({ environmentId, skillIds }) =>
        io.fetchSkills(environmentId, skillIds).catch(() => []),
      ),
    )
  ).flat();
  const results = await Promise.all(
    plan.targets.map(async (target) => {
      const { patch, complete } = completeAgentLibraryPatch(plan.library, target, fetched);
      const accepted = isEmptyPatch(patch) || (await io.replicate(target.environmentId, patch));
      return accepted && complete;
    }),
  );
  return results.every(Boolean);
}

const libraryFingerprint = (library: AgentLibraryInput | undefined) =>
  JSON.stringify([
    library?.mcpGatewayProfiles.map((item) => [item.profileId, item.name, item.updatedAt]),
    library?.agentSkills?.map((item) => [item.skillId, item.updatedAt]),
    library?.mcpGatewayProfileDeletedAt,
    library?.agentSkillDeletedAt,
  ]);

/**
 * Sends each target's patch once until it fails or that target's library changes. An older
 * server that drops part of a patch (an exact-name repeat) would otherwise get it on every pass.
 */
export function createAgentLibrarySyncGate() {
  const inFlight = new Set<string>();
  const delivered = new Map<string, string>();
  return {
    take(plan: AgentLibrarySyncPlan, sources: ReadonlyArray<AgentLibrarySource>) {
      for (const environmentId of delivered.keys())
        if (!plan.targets.some((target) => target.environmentId === environmentId))
          delivered.delete(environmentId);
      const keyed = plan.targets.flatMap((target) => {
        const own = sources.find((source) => source.environmentId === target.environmentId);
        const key = JSON.stringify([target.patch, libraryFingerprint(own?.library)]);
        const id = `${target.environmentId}:${key}`;
        return inFlight.has(id) || delivered.get(target.environmentId) === key
          ? []
          : [{ target, key, id }];
      });
      for (const { id } of keyed) inFlight.add(id);
      return {
        targets: keyed.map(({ target }) => target),
        settle(accepted: boolean) {
          for (const { target, key, id } of keyed) {
            inFlight.delete(id);
            if (accepted) delivered.set(target.environmentId, key);
            else delivered.delete(target.environmentId);
          }
        },
      };
    },
  };
}

const withoutServerOwned = <T extends { revision: number; createdAt: string; updatedAt: string }>({
  revision: _revision,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...content
}: T) => content;

/**
 * Turns a whole-library settings patch into per-item operations, so a concurrent edit to another
 * item survives. Each operation applies whatever was saved elsewhere. Other settings stay in `rest`.
 */
export function agentLibraryOperationsFromPatch(
  snapshot: {
    readonly agentSkills: ReadonlyArray<AgentSkill>;
    readonly mcpGatewayProfiles: ReadonlyArray<McpGatewayProfile>;
  },
  patch: ServerSettingsPatch,
): {
  readonly operations: ReadonlyArray<AgentLibraryOperation>;
  readonly rest: ServerSettingsPatch;
} {
  const {
    mcpGatewayProfiles,
    agentSkills,
    mcpGatewayProfileDeletedAt: _profileDeletedAt,
    agentSkillDeletedAt: _skillDeletedAt,
    ...rest
  } = patch;
  const skillUpserts: AgentLibraryOperation[] = [];
  const skillDeletes: AgentLibraryOperation[] = [];
  const profileOperations: AgentLibraryOperation[] = [];
  if (agentSkills !== undefined) {
    for (const skill of agentSkills) {
      const seen = snapshot.agentSkills.find((item) => item.skillId === skill.skillId);
      if (seen && Equal.equals(withoutServerOwned(seen), withoutServerOwned(skill))) continue;
      skillUpserts.push({ type: "skill.upsert", skill });
    }
    for (const seen of snapshot.agentSkills) {
      if (!agentSkills.some((skill) => skill.skillId === seen.skillId))
        skillDeletes.push({ type: "skill.delete", skillId: seen.skillId });
    }
  }
  if (mcpGatewayProfiles !== undefined) {
    for (const profile of mcpGatewayProfiles) {
      const seen = snapshot.mcpGatewayProfiles.find((item) => item.profileId === profile.profileId);
      if (seen && Equal.equals(withoutServerOwned(seen), withoutServerOwned(profile))) continue;
      profileOperations.push({ type: "profile.upsert", profile });
    }
    for (const seen of snapshot.mcpGatewayProfiles) {
      if (!mcpGatewayProfiles.some((profile) => profile.profileId === seen.profileId))
        profileOperations.push({ type: "profile.delete", profileId: seen.profileId });
    }
  }
  // New skills exist before agents reference them; deletions unassign after agent edits land.
  return { operations: [...skillUpserts, ...profileOperations, ...skillDeletes], rest };
}

const isRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

const readLiveLibrary = Effect.fn("readLiveLibrary")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return Option.none();
  const config = yield* session.value.initialConfig;
  if (!config.environment.capabilities.agentLibrarySync) return Option.none();
  const { settings } = yield* request(WS_METHODS.serverGetConfig, {
    agentSkillBodiesOnDemand: true,
  });
  return Option.some({ ...config, settings });
});

/** Await convergence at the command boundary, including MCP and mobile callers. */
export const syncAgentLibraryBeforeUse = Effect.fn("syncAgentLibraryBeforeUse")(function* (
  profileId?: string,
) {
  const registry = yield* Effect.serviceOption(EnvironmentRegistry);
  if (Option.isNone(registry)) return;
  const entries = yield* SubscriptionRef.get(registry.value.entries);
  if (entries.size < 2 && profileId === undefined) return;
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  return yield* Effect.gen(function* () {
    const targetOption = yield* readLiveLibrary();
    if (Option.isNone(targetOption)) return;
    const target = targetOption.value;
    const cache = yield* Effect.serviceOption(EnvironmentCacheStore);
    const cached = (id: EnvironmentId) =>
      Option.isSome(cache)
        ? cache.value.loadServerConfig(id).pipe(
            Effect.map(Option.map((config) => ({ config, live: false }))),
            Effect.orElseSucceed(() => Option.none()),
          )
        : Effect.succeedNone;
    const peers = yield* Effect.forEach(
      [...entries.keys()].filter((id) => id !== environmentId),
      Effect.fnUntraced(function* (id) {
        const state = yield* registry.value.state(id);
        const peer =
          state.phase === "connected"
            ? yield* registry.value.run(id, readLiveLibrary()).pipe(
                Effect.map(Option.map((config) => ({ config, live: true }))),
                Effect.catch(() => cached(id)),
              )
            : yield* cached(id);
        return Option.map(peer, ({ config, live }) => ({
          environmentId: id,
          library: config.settings,
          capabilities: config.environment.capabilities,
          live,
        }));
      }),
      { concurrency: 4 },
    );
    const plan = planAgentLibrarySync(
      [
        {
          environmentId,
          library: target.settings,
          capabilities: target.environment.capabilities,
          live: true,
        },
        ...peers.flatMap((peer) => (Option.isSome(peer) ? [peer.value] : [])),
      ],
      { targets: [environmentId] },
    );
    const library = plan.library;
    if (
      library.agentSkills.some(agentSkillHasResources) &&
      target.environment.capabilities.agentSkillResources !== true
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: "Update T3 on this machine to synchronize skill resources.",
      });
    }
    if (
      target.environment.capabilities.agentSkillsSync !== true &&
      profileId &&
      library.mcpGatewayProfiles.some(
        (profile) => profile.profileId === profileId && profile.skillIds?.length,
      )
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: "Update T3 on this machine to use shared agent skills.",
      });
    }
    const pending = plan.targets[0];
    const written = new Set((target.settings.agentSkills ?? []).map((skill) => skill.skillId));
    if (pending) {
      const fetched = yield* Effect.forEach(
        plan.fetches,
        ({ environmentId: source, skillIds }) =>
          registry.value.run(source, request(WS_METHODS.serverGetAgentSkills, { skillIds })).pipe(
            Effect.map((result) => result.agentSkills),
            Effect.orElseSucceed((): ReadonlyArray<AgentSkill> => []),
          ),
        { concurrency: 4 },
      );
      const { patch } = completeAgentLibraryPatch(library, pending, fetched.flat());
      if (!isEmptyPatch(patch))
        yield* request(WS_METHODS.serverUpdateSettings, {
          patch,
          replicateProfiles: true,
          agentSkillBodiesOnDemand: true,
        });
      for (const skill of patch.agentSkills ?? []) written.add(skill.skillId);
    }
    const profile = library.mcpGatewayProfiles.find((item) => item.profileId === profileId);
    const missing = profile ? missingAgentSkills(library, profile, written) : [];
    if (target.environment.capabilities.agentSkillsSync === true && missing.length > 0) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: `${profile!.name} needs ${missing.map((name) => `"${name}"`).join(", ")}, which no connected machine can provide. Connect the machine that holds ${missing.length === 1 ? "it" : "them"} and try again.`,
      });
    }
    return library;
  }).pipe(
    Effect.mapError((cause) =>
      isRpcUnavailable(cause)
        ? cause
        : new EnvironmentRpcUnavailableError({
            environmentId,
            message: `Could not synchronize the agent library before use: ${String(cause)}`,
          }),
    ),
  );
});
