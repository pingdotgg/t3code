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
    const patch = agentLibraryForSync(library, supportsSkills);
    if (
      !Equal.equals(
        patch,
        agentLibraryForSync(mergeAgentLibraries([target.settings]), supportsSkills),
      )
    ) {
      yield* request(WS_METHODS.serverUpdateSettings, { patch, replicateProfiles: true });
    }
    return library;
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
