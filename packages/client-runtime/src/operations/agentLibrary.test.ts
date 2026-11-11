import { startThreadTurn } from "./commands.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { RpcSession } from "../rpc/session.ts";
import type { PreparedConnection, SupervisorConnectionState } from "../connection/model.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadLaunchInput,
  EnvironmentId,
  WS_METHODS,
  mergeAgentLibraries,
  agentSkillDigest,
  toAgentSkillStub,
  type AgentSkill,
  type McpGatewayProfile,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  agentLibraryOperationsFromPatch,
  planAgentLibrarySync,
  syncAgentLibraryBeforeUse,
  withAgentSkillBodies,
  type AgentLibrarySource,
} from "./agentLibrary.ts";

it.effect(
  "awaits the newest remote prompt and skill revision and does not resurrect deletions",
  () =>
    Effect.gen(function* () {
      const localId = EnvironmentId.make("local");
      const remoteId = EnvironmentId.make("remote");
      const profile = {
        profileId: "randy",
        name: "Randy",
        systemPrompt: "Old rules",
        skillIds: ["review"],
        revision: 1,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      };
      const skill = {
        skillId: "review",
        name: "Review",
        description: "Review changes",
        content: "Old skill",
        revision: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      };
      let local: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        mcpGatewayProfiles: [profile],
        agentSkills: [skill],
      };
      let remote: ServerSettings = {
        ...local,
        mcpGatewayProfiles: [
          { ...profile, systemPrompt: "New rules", revision: 2, updatedAt: "2026-01-02" },
        ],
        agentSkills: [
          {
            ...skill,
            content: "New skill",
            resources: [{ path: "references/nested/rules.md", contentBase64: "b2s=" }],
            revision: 2,
            updatedAt: "2026-01-02",
          },
        ],
      };
      let writes = 0;
      const dispatched: OrchestrationV2ThreadLaunchInput[] = [];
      const makeSupervisor = Effect.fnUntraced(function* (id: EnvironmentId) {
        const target = new PrimaryConnectionTarget({
          environmentId: id,
          label: id,
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        });
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.launchThread]: (command: OrchestrationV2ThreadLaunchInput) =>
            Effect.sync(() => {
              dispatched.push(command);
              expect(local.mcpGatewayProfiles[0]?.systemPrompt).toBe("New rules");
              expect(local.agentSkills[0]?.content).toBe("New skill");
              expect(local.agentSkills[0]?.resources).toEqual([
                { path: "references/nested/rules.md", contentBase64: "b2s=" },
              ]);
              return { sequence: 1 };
            }),
          [WS_METHODS.serverGetConfig]: () =>
            Effect.sync(() => ({ settings: id === localId ? local : remote })),
          [WS_METHODS.serverUpdateSettings]: ({
            patch,
            replicateProfiles,
          }: {
            patch: ServerSettings;
            replicateProfiles: boolean;
          }) =>
            Effect.sync(() => {
              expect(replicateProfiles).toBe(true);
              expect(id).toBe(localId);
              writes += 1;
              local = { ...local, ...mergeAgentLibraries([local, patch]) };
              return local;
            }),
        } as unknown as WsRpcProtocolClient;
        return EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
          session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
            Option.some({
              client,
              inboundFrames: Effect.succeed(0),
              initialConfig: Effect.succeed({
                environment: {
                  capabilities: {
                    agentLibrarySync: true,
                    agentSkillsSync: true,
                    agentSkillResources: true,
                  },
                },
              } as ServerConfig),
              subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
            }),
          ),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
      });
      const source = yield* makeSupervisor(remoteId);
      const target = yield* makeSupervisor(localId);
      const entries = yield* SubscriptionRef.make(
        new Map(
          [source, target].map((supervisor) => [
            supervisor.target.environmentId,
            { target: supervisor.target, enabled: true, profile: Option.none() },
          ]),
        ),
      );
      const registry = {
        entries,
        state: () => Effect.succeed({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const }),
        run: <A, E, R>(id: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(EnvironmentSupervisor, id === localId ? target : source),
          ),
      } as unknown as EnvironmentRegistry["Service"];
      const sync = syncAgentLibraryBeforeUse().pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(EnvironmentSupervisor, target),
      );
      yield* startThreadTurn({
        commandId: CommandId.make("start-review"),
        createdAt: "2026-01-03",
        threadId: ThreadId.make("review"),
        runtimeMode: "full-access",
        interactionMode: "default",
        message: {
          messageId: MessageId.make("message"),
          role: "user",
          text: "Review",
          attachments: [],
        },
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project"),
            title: "Review",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-03",
            profileSelection: { profileId: "randy", revision: 1, overrideFields: [] },
            branch: null,
            worktreePath: null,
          },
        },
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(EnvironmentSupervisor, target),
        Effect.provideService(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size)),
        ),
      );
      expect(dispatched[0]).toMatchObject({
        profileSelection: { profileId: "randy", revision: 2, overrideFields: [] },
      });
      expect(local.mcpGatewayProfiles[0]?.systemPrompt).toBe("New rules");
      expect(local.agentSkills[0]?.content).toBe("New skill");
      expect(local.agentSkills[0]?.resources).toEqual([
        { path: "references/nested/rules.md", contentBase64: "b2s=" },
      ]);
      expect(writes).toBe(1);
      yield* sync;
      expect(writes).toBe(1);
      remote = { ...remote, agentSkills: [], agentSkillDeletedAt: { review: "2026-01-03" } };
      yield* sync;
      expect(local.agentSkills).toEqual([]);
      remote = { ...remote, agentSkills: [skill], agentSkillDeletedAt: {} };
      yield* sync;
      expect(local.agentSkills).toEqual([]);
      expect(writes).toBe(2);
    }),
);

it("plans per-target patches with only missing or older items and fetches stub bodies from a holder", () => {
  const agent: McpGatewayProfile = {
    profileId: "randy",
    name: "Randy",
    skillIds: ["review"],
    iconId: "rocket",
    revision: 2,
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  };
  const oldSkill: AgentSkill = {
    skillId: "review",
    name: "Review",
    description: "Review code",
    content: "Old rules",
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const newSkill = { ...oldSkill, content: "New rules", revision: 2, updatedAt: "2026-01-02" };
  const offlineSkill = { ...oldSkill, skillId: "offline", updatedAt: "2026-01-03" };
  const stub = (skill: AgentSkill) => toAgentSkillStub(skill, agentSkillDigest(skill));
  const current = {
    agentLibrarySync: true,
    agentSkillsSync: true,
    agentSkillResources: true,
    agentSkillBodiesOnDemand: true,
    agentLibraryMutations: true,
  };
  const source = (
    id: string,
    library: AgentLibrarySource["library"],
    capabilities: AgentLibrarySource["capabilities"] = current,
    live = true,
  ): AgentLibrarySource => ({ environmentId: EnvironmentId.make(id), library, capabilities, live });
  const plan = planAgentLibrarySync([
    source("holder", { mcpGatewayProfiles: [agent], agentSkills: [stub(newSkill)] }),
    source("stale", { mcpGatewayProfiles: [agent], agentSkills: [stub(oldSkill)] }),
    source("legacy", { mcpGatewayProfiles: [] }, { agentLibrarySync: true }),
    source("cached", { mcpGatewayProfiles: [], agentSkills: [stub(offlineSkill)] }, current, false),
  ]);
  // Only the cached machine holds `offline`, and nobody live can serve its body yet.
  expect(plan.targets.map((target) => target.environmentId)).toEqual(["stale", "legacy"]);
  const [stale, legacy] = plan.targets;
  expect(stale?.patch.mcpGatewayProfiles).toEqual([]);
  expect(stale?.patch.agentSkills).toEqual([stub(newSkill)]);
  const { skillIds: _skillIds, iconId: _iconId, ...legacyAgent } = agent;
  expect(legacy?.patch).toEqual({
    mcpGatewayProfiles: [legacyAgent],
    mcpGatewayProfileDeletedAt: {},
  });
  expect(plan.fetches).toEqual([{ environmentId: "holder", skillIds: ["review"] }]);
  expect(withAgentSkillBodies(stale!.patch, [newSkill]).agentSkills).toEqual([newSkill]);
  // A body that changed since the plan names another version and waits for the next pass.
  expect(
    withAgentSkillBodies(stale!.patch, [{ ...newSkill, content: "Newer" }]).agentSkills,
  ).toEqual([]);
});

it("turns a whole-library patch into per-item operations against the snapshot the caller saw", () => {
  const agent = (id: string, revision: number, name = id): McpGatewayProfile => ({
    profileId: id,
    name,
    revision,
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  const skill: AgentSkill = {
    skillId: "review",
    name: "Review",
    description: "",
    content: "Rules",
    revision: 3,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const snapshot = {
    mcpGatewayProfiles: [agent("a", 2), agent("b", 5), agent("c", 1)],
    agentSkills: [toAgentSkillStub(skill, agentSkillDigest(skill))],
  };
  const created = agent("d", 1);
  const { operations, rest } = agentLibraryOperationsFromPatch(snapshot, {
    mcpGatewayProfiles: [agent("a", 2), agent("b", 5, "Bea"), created],
    agentSkills: [],
    newWorktreesStartFromOrigin: true,
  });
  expect(operations).toEqual([
    { type: "profile.upsert", profile: agent("b", 5, "Bea"), baseRevision: 5 },
    { type: "profile.upsert", profile: created, baseRevision: null },
    { type: "profile.delete", profileId: "c", baseRevision: 1 },
    { type: "skill.delete", skillId: "review", baseRevision: 3 },
  ]);
  expect(rest).toEqual({ newWorktreesStartFromOrigin: true });
});
