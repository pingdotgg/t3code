import { agentLibraryForSync, mergeAgentLibraries, WS_METHODS } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";

const readLiveLibrary = Effect.fn("readLiveLibrary")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return Option.none();
  const config = yield* session.value.initialConfig;
  if (!config.environment.capabilities.agentLibrarySync) return Option.none();
  const { settings } = yield* request(WS_METHODS.serverGetConfig, {});
  return Option.some({ ...config, settings });
});

/** The merged library and what writing it to the target would patch, if anything. */
const planAgentLibrarySync = Effect.fn("planAgentLibrarySync")(function* (profileId?: string) {
  const registry = yield* Effect.serviceOption(EnvironmentRegistry);
  if (Option.isNone(registry)) return undefined;
  const entries = yield* SubscriptionRef.get(registry.value.entries);
  if (entries.size < 2 && profileId === undefined) return undefined;
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  return yield* Effect.gen(function* () {
    const targetOption = yield* readLiveLibrary();
    if (Option.isNone(targetOption)) return undefined;
    const target = targetOption.value;
    const cache = yield* Effect.serviceOption(EnvironmentCacheStore);
    const cached = (id: typeof environmentId) =>
      Option.isSome(cache)
        ? cache.value.loadServerConfig(id).pipe(Effect.orElseSucceed(() => Option.none()))
        : Effect.succeedNone;
    const peers = yield* Effect.forEach(
      [...entries.keys()].filter((id) => id !== environmentId),
      Effect.fnUntraced(function* (id) {
        const state = yield* registry.value.state(id);
        return state.phase === "connected"
          ? yield* registry.value.run(id, readLiveLibrary()).pipe(Effect.catch(() => cached(id)))
          : yield* cached(id);
      }),
      { concurrency: 4 },
    );
    const library = mergeAgentLibraries([
      target.settings,
      ...peers.flatMap((peer) =>
        Option.isSome(peer) && peer.value.environment.capabilities.agentLibrarySync
          ? [peer.value.settings]
          : [],
      ),
    ]);
    if (
      library.agentSkills.some((skill) => skill.resources?.length) &&
      target.environment.capabilities.agentSkillResources !== true
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId,
        message: "Update T3 on this machine to synchronize skill resources.",
      });
    }
    const supportsSkills = target.environment.capabilities.agentSkillsSync === true;
    if (
      !supportsSkills &&
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
    return {
      library,
      patch: agentLibraryForSync(library, supportsSkills),
      current: agentLibraryForSync(mergeAgentLibraries([target.settings]), supportsSkills),
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentRpcUnavailableError({
          environmentId,
          message: `Could not synchronize the agent library before use: ${String(cause)}`,
        }),
    ),
  );
});

/** Await convergence at the command boundary, including MCP and mobile callers. */
export const syncAgentLibraryBeforeUse = Effect.fn("syncAgentLibraryBeforeUse")(function* (
  profileId?: string,
) {
  const plan = yield* planAgentLibrarySync(profileId);
  if (plan === undefined) return;
  if (!Equal.equals(plan.patch, plan.current)) {
    const environmentId = (yield* EnvironmentSupervisor).target.environmentId;
    yield* request(WS_METHODS.serverUpdateSettings, {
      patch: plan.patch,
      replicateProfiles: true,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentRpcUnavailableError({
            environmentId,
            message: `Could not synchronize the agent library before use: ${String(cause)}`,
          }),
      ),
    );
  }
  return plan.library;
});

const changedIds = <A>(
  before: ReadonlyArray<A> | undefined,
  after: ReadonlyArray<A> | undefined,
  id: (item: A) => string,
) => {
  const previous = new Map((before ?? []).map((item) => [id(item), JSON.stringify(item)]));
  const next = new Map((after ?? []).map((item) => [id(item), JSON.stringify(item)]));
  return [...new Set([...previous.keys(), ...next.keys()])].filter(
    (key) => previous.get(key) !== next.get(key),
  );
};

/**
 * What synchronizing would change on the target, without writing it: the skills it adds,
 * rewrites or drops, the agents it touches, and those agents as they would be.
 */
export const agentLibrarySyncChanges = Effect.fn("agentLibrarySyncChanges")(function* () {
  const plan = yield* planAgentLibrarySync();
  if (plan === undefined) return { skillIds: [], profileIds: [], profiles: [] };
  const skills = (library: typeof plan.patch) =>
    "agentSkills" in library ? library.agentSkills : undefined;
  const profileIds = changedIds(
    plan.current.mcpGatewayProfiles,
    plan.patch.mcpGatewayProfiles,
    (profile) => profile.profileId,
  );
  return {
    skillIds: changedIds(skills(plan.current), skills(plan.patch), (skill) => skill.skillId),
    profileIds,
    profiles: plan.patch.mcpGatewayProfiles.filter((profile) =>
      profileIds.includes(profile.profileId),
    ),
  };
});
