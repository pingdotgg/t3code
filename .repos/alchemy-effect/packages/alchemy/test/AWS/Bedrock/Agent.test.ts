import * as AWS from "@/AWS";
import { Agent, AgentAlias } from "@/AWS/Bedrock";
import * as Test from "@/Test/Alchemy";
import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Nova Micro via the us cross-region inference profile — the cheapest
// on-demand model enabled in the testing account, supported by Bedrock Agents.
const MODEL = "us.amazon.nova-micro-v1:0";
const INSTRUCTION =
  "You are a helpful assistant. Answer every question as concisely as you can.";

const findAgent = (agentId: string) =>
  bedrock.getAgent({ agentId }).pipe(
    Effect.map((r) => r.agent),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const findAlias = (agentId: string, agentAliasId: string) =>
  bedrock.getAgentAlias({ agentId, agentAliasId }).pipe(
    Effect.map((r) => r.agentAlias),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

const assertAgentGone = (agentId: string) =>
  findAgent(agentId).pipe(
    Effect.flatMap((a) =>
      a === undefined || a.agentStatus === "DELETING"
        ? Effect.void
        : Effect.fail(new StillExists({ what: `agent ${agentId}` })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([Schedule.exponential(1000), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create + prepare agent, attach alias, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Deploy an agent (auto-created execution role) and an alias.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const agent = yield* Agent("TestAgent", {
            foundationModel: MODEL,
            instruction: INSTRUCTION,
            description: "alchemy bedrock agent test",
            tags: { Environment: "test" },
          });
          const alias = yield* AgentAlias("TestAlias", {
            agentId: agent.agentId,
            description: "prod alias",
          });
          return {
            agentId: agent.agentId,
            agentArn: agent.agentArn,
            roleName: agent.roleName,
            aliasId: alias.agentAliasId,
            aliasArn: alias.agentAliasArn,
          };
        }),
      );

      expect(result.agentId).toBeDefined();
      expect(result.agentArn).toContain(":agent/");
      expect(result.aliasId).toBeDefined();

      // out-of-band: agent is prepared, tags branded, role exists.
      const created = yield* findAgent(result.agentId);
      expect(created).toBeDefined();
      expect(["PREPARED", "NOT_PREPARED"]).toContain(created!.agentStatus);
      expect(created!.foundationModel).toBe(MODEL);

      const tags = yield* bedrock
        .listTagsForResource({ resourceArn: result.agentArn })
        .pipe(Effect.map((r) => r.tags ?? {}));
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestAgent");

      expect(result.roleName).toBeDefined();
      const role = yield* iam
        .getRole({ RoleName: result.roleName! })
        .pipe(Effect.map((r) => r.Role));
      expect(role.Arn).toBe(created!.agentResourceRoleArn);

      // out-of-band: alias exists and is prepared.
      const alias = yield* findAlias(result.agentId, result.aliasId);
      expect(alias).toBeDefined();
      expect(["PREPARED", "UPDATING"]).toContain(alias!.agentAliasStatus);

      // 2. Update the agent's instruction — converges via updateAgent.
      yield* stack.deploy(
        Effect.gen(function* () {
          const agent = yield* Agent("TestAgent", {
            foundationModel: MODEL,
            instruction: `${INSTRUCTION} Always cite your reasoning.`,
            description: "alchemy bedrock agent test (updated)",
            tags: { Environment: "test" },
          });
          yield* AgentAlias("TestAlias", {
            agentId: agent.agentId,
            description: "prod alias",
          });
          return agent.agentId;
        }),
      );

      const updated = yield* findAgent(result.agentId);
      expect(updated!.description).toBe("alchemy bedrock agent test (updated)");

      // 3. Destroy — agent, alias, and managed role are all removed.
      yield* stack.destroy();
      yield* assertAgentGone(result.agentId);

      const roleGone = yield* iam.getRole({ RoleName: result.roleName! }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed(true)),
      );
      expect(roleGone).toBe(true);
    }),
  { timeout: 240_000 },
);
