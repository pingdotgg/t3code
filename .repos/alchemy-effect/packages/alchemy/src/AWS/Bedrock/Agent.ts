import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as iam from "@distilled.cloud/aws/iam";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays, toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import { bedrockModelArns } from "./ModelArns.ts";

/**
 * A guardrail attached to an agent to apply content filters, denied topics,
 * word filters, and sensitive-information policies to model interactions.
 */
export interface AgentGuardrailConfiguration {
  /** The unique identifier of the guardrail. */
  guardrailIdentifier?: string;
  /** The version of the guardrail. */
  guardrailVersion?: string;
}

/**
 * Long-term memory configuration for an agent — lets the agent retain
 * conversational context across sessions as asynchronously generated
 * session summaries, readable at runtime via the `GetAgentMemory` binding.
 */
export interface AgentMemoryConfiguration {
  /**
   * The types of memory to enable. `"SESSION_SUMMARY"` is currently the
   * only supported type.
   */
  enabledMemoryTypes: bedrock.MemoryType[];
  /**
   * How long the agent retains memory (e.g. `"30 days"` or
   * `Duration.days(30)`; a bare number is milliseconds). Between 1 and
   * 365 days. Sent to the API as whole days (`storageDays`).
   * @default 30 days
   */
  storage?: Duration.Input;
  /**
   * Configuration for `SESSION_SUMMARY` memory.
   */
  sessionSummaryConfiguration?: {
    /** The maximum number of recent session summaries to include. */
    maxRecentSessions?: number;
  };
}

export interface AgentProps {
  /**
   * Name of the agent (1-100 characters; letters, digits, and the
   * characters `_-`). If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing the name
   * triggers a replacement.
   */
  agentName?: string;
  /**
   * The foundation model or inference-profile id the agent uses for
   * orchestration — a foundation-model id
   * (`anthropic.claude-3-5-sonnet-20240620-v1:0`), a cross-region inference
   * profile id (`us.anthropic.claude-3-5-sonnet-20240620-v1:0`), or a full
   * Bedrock ARN. Model access must be enabled in the account.
   */
  foundationModel: string;
  /**
   * Instructions that tell the agent what it should do and how it should
   * interact with users. Must be at least 40 characters for the agent to be
   * preparable.
   */
  instruction: string;
  /**
   * A description of the agent.
   */
  description?: string;
  /**
   * The ARN of an existing IAM role for the agent to assume. When omitted,
   * an execution role is created automatically with `bedrock.amazonaws.com`
   * trust and `bedrock:InvokeModel` granted on {@link AgentProps.foundationModel}.
   */
  agentResourceRoleArn?: string;
  /**
   * How long the agent retains an idle session before it is ended (e.g.
   * `"30 minutes"` or `Duration.minutes(30)`; a bare number is milliseconds).
   * Between 1 minute and 1 hour. Sent to the API as whole seconds
   * (`idleSessionTTLInSeconds`).
   * @default 600 seconds
   */
  idleSessionTTL?: Duration.Input;
  /**
   * The ARN of a KMS key to encrypt the agent with.
   */
  customerEncryptionKeyArn?: string;
  /**
   * A guardrail to apply to the agent's model interactions.
   */
  guardrailConfiguration?: AgentGuardrailConfiguration;
  /**
   * Long-term memory configuration. When enabled the agent summarizes each
   * session after it ends and retains the summaries for
   * {@link AgentMemoryConfiguration.storage}, making them available to
   * later sessions that share the same memory id (and to the
   * `GetAgentMemory` / `DeleteAgentMemory` runtime bindings).
   */
  memoryConfiguration?: AgentMemoryConfiguration;
  /**
   * Whether to prepare the agent (compile the DRAFT version) after every
   * create and update so it is invocable and can back an
   * {@link AgentAlias}. Preparation is polled to completion.
   * @default true
   */
  prepare?: boolean;
  /**
   * Tags to apply to the agent. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Agent extends Resource<
  "AWS.Bedrock.Agent",
  AgentProps,
  {
    /**
     * The unique identifier of the agent.
     */
    agentId: string;
    /**
     * The ARN of the agent.
     */
    agentArn: string;
    /**
     * Name of the agent.
     */
    agentName: string;
    /** The DRAFT version identifier (always `"DRAFT"`). */
    agentVersion: string;
    /** The ARN of the role the agent assumes. */
    agentResourceRoleArn: string;
    /**
     * Name of the auto-created execution role. `undefined` when an explicit
     * {@link AgentProps.agentResourceRoleArn} is used.
     */
    roleName: string | undefined;
  }
> {}

/**
 * An Amazon Bedrock agent — a foundation model driven by natural-language
 * instructions that can orchestrate multi-step tasks.
 *
 * `Agent` owns the lifecycle of the agent's DRAFT version. An IAM execution
 * role is created automatically (trusted by `bedrock.amazonaws.com`, granted
 * `bedrock:InvokeModel` on the foundation model) unless an explicit
 * `agentResourceRoleArn` is supplied. After every create/update the agent is
 * prepared (unless `prepare: false`) so it is immediately invocable and can
 * back an {@link AgentAlias}.
 *
 * @resource
 * @section Creating Agents
 * @example Minimal Agent
 * ```typescript
 * import * as Bedrock from "alchemy/AWS/Bedrock";
 *
 * const agent = yield* Bedrock.Agent("assistant", {
 *   foundationModel: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 *   instruction:
 *     "You are a helpful assistant that answers questions concisely.",
 * });
 * ```
 *
 * @example Agent with a Guardrail and Custom Session TTL
 * ```typescript
 * const agent = yield* Bedrock.Agent("assistant", {
 *   foundationModel: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 *   instruction: "You are a careful, policy-compliant support agent.",
 *   idleSessionTTL: "30 minutes",
 *   guardrailConfiguration: {
 *     guardrailIdentifier: guardrail.guardrailId,
 *     guardrailVersion: "DRAFT",
 *   },
 * });
 * ```
 *
 * @example Agent with Long-Term Memory
 * ```typescript
 * // Session summaries are retained for 30 days and readable at runtime
 * // through the GetAgentMemory binding.
 * const agent = yield* Bedrock.Agent("assistant", {
 *   foundationModel: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 *   instruction: "You are a helpful assistant that remembers past sessions.",
 *   memoryConfiguration: {
 *     enabledMemoryTypes: ["SESSION_SUMMARY"],
 *     storage: "30 days",
 *   },
 * });
 * ```
 */
export const Agent = Resource<Agent>("AWS.Bedrock.Agent");

/** Map the declared memory props onto the wire `MemoryConfiguration`. */
const toWireMemoryConfiguration = (
  memory: AgentMemoryConfiguration | undefined,
): bedrock.MemoryConfiguration | undefined =>
  memory === undefined
    ? undefined
    : {
        enabledMemoryTypes: [...memory.enabledMemoryTypes],
        storageDays: toWireDays(memory.storage),
        sessionSummaryConfiguration: memory.sessionSummaryConfiguration,
      };

/** Agent status values from which no further transition is pending. */
const AGENT_SETTLED = new Set(["NOT_PREPARED", "PREPARED", "FAILED"]);

/** Agent status values indicating an in-flight transition to wait out. */
const AGENT_TRANSIENT = new Set([
  "CREATING",
  "UPDATING",
  "PREPARING",
  "VERSIONING",
]);

/**
 * A freshly created IAM role is eventually consistent; `createAgent` can
 * transiently reject a role it cannot yet assume with a `ValidationException`.
 * Wrapped in an explicitly-typed generic helper so the `Effect.retry`
 * conditional return type does not leak into declaration emit and widen the
 * provider layer's requirement to `unknown` (see PATTERNS §7).
 */
const retryWhileRoleAssumeFails = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ValidationException" &&
      "message" in e &&
      typeof e.message === "string" &&
      e.message.toLowerCase().includes("unable to assume"),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

export const AgentProvider = () =>
  Provider.effect(
    Agent,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: AgentProps) {
        return (
          props.agentName ?? (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const getAgentOrUndefined = Effect.fn(function* (agentId: string) {
        return yield* bedrock.getAgent({ agentId }).pipe(
          Effect.map((r) => r.agent),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* bedrock.listAgents
          .pages({})
          .pipe(Stream.runCollect);
        const summary = Array.from(pages)
          .flatMap((page) => page.agentSummaries ?? [])
          .find((s) => s.agentName === name);
        return summary?.agentId;
      });

      const fetchObservedTags = Effect.fn(function* (resourceArn: string) {
        return yield* bedrock.listTagsForResource({ resourceArn }).pipe(
          Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      // Poll the agent to a settled (non-transient) status. Bounded: creation
      // and preparation both complete within seconds to ~1 minute.
      const waitForSettled = Effect.fn(function* (agentId: string) {
        return yield* bedrock.getAgent({ agentId }).pipe(
          Effect.map((r) => r.agent),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.repeat({
            schedule: Schedule.fixed("3 seconds"),
            until: (agent) =>
              agent === undefined || !AGENT_TRANSIENT.has(agent.agentStatus),
            times: 40,
          }),
        );
      });

      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        region,
        accountId,
        foundationModel,
      }: {
        id: string;
        roleName: string;
        region: string;
        accountId: string;
        foundationModel: string;
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "bedrock.amazonaws.com" },
                  Action: "sts:AssumeRole",
                  Condition: {
                    StringEquals: { "aws:SourceAccount": accountId },
                    ArnLike: {
                      "aws:SourceArn": `arn:aws:bedrock:${region}:${accountId}:agent/*`,
                    },
                  },
                },
              ],
            }),
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );

        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: "BedrockAgentInvokeModel",
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "bedrock:InvokeModel",
                  "bedrock:InvokeModelWithResponseStream",
                ],
                Resource: bedrockModelArns(region, accountId, foundationModel),
              },
            ],
          }),
        });

        return role.Role.Arn;
      });

      return Agent.Provider.of({
        stables: ["agentId", "agentArn", "agentName"],

        list: () =>
          Effect.gen(function* () {
            const { region, accountId } = yield* AWSEnvironment.current;
            const pages = yield* bedrock.listAgents
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.agentSummaries ?? [],
            );
            return summaries.map((s) => ({
              agentId: s.agentId,
              agentArn: `arn:aws:bedrock:${region}:${accountId}:agent/${s.agentId}`,
              agentName: s.agentName,
              agentVersion: "DRAFT",
              agentResourceRoleArn: "",
              roleName: undefined as string | undefined,
            }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const agentId =
            output?.agentId ??
            (yield* findByName(
              output?.agentName ??
                (yield* createName(id, olds ?? ({} as AgentProps))),
            ));
          if (agentId === undefined) return undefined;
          const agent = yield* getAgentOrUndefined(agentId);
          if (agent === undefined || agent.agentStatus === "DELETING") {
            return undefined;
          }
          const attrs = {
            agentId: agent.agentId,
            agentArn: agent.agentArn,
            agentName: agent.agentName,
            agentVersion: agent.agentVersion ?? "DRAFT",
            agentResourceRoleArn: agent.agentResourceRoleArn,
            roleName: output?.roleName,
          };
          const tags = yield* fetchObservedTags(agent.agentArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? ({} as AgentProps));
          const newName = yield* createName(id, news ?? ({} as AgentProps));
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // foundationModel, instruction, description, guardrail, TTL, and
          // tags all converge via updateAgent.
        }),

        reconcile: Effect.fn(function* ({
          id,
          news = {} as AgentProps,
          output,
          session,
        }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.agentName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Ensure the execution role first — the agent cannot exist without
          // one. Managed unless an explicit agentResourceRoleArn is provided.
          let roleArn = news.agentResourceRoleArn;
          let roleName = output?.roleName;
          if (roleArn === undefined) {
            roleName = roleName ?? (yield* createRoleName(id));
            roleArn = yield* ensureExecutionRole({
              id,
              roleName,
              region,
              accountId,
              foundationModel: news.foundationModel,
            });
          }

          // 1. OBSERVE — cloud state is authoritative; output is only an id
          //    cache. Fall back to a name lookup after state loss.
          let agent = output?.agentId
            ? yield* getAgentOrUndefined(output.agentId)
            : undefined;
          if (agent === undefined) {
            const foundId = yield* findByName(name);
            if (foundId !== undefined) {
              agent = yield* getAgentOrUndefined(foundId);
            }
          }

          if (agent === undefined) {
            // 2. ENSURE — create.
            const created = yield* retryWhileRoleAssumeFails(
              bedrock.createAgent({
                agentName: name,
                foundationModel: news.foundationModel,
                instruction: news.instruction,
                description: news.description,
                agentResourceRoleArn: roleArn,
                idleSessionTTLInSeconds: toWireSeconds(news.idleSessionTTL),
                customerEncryptionKeyArn: news.customerEncryptionKeyArn,
                guardrailConfiguration: news.guardrailConfiguration,
                memoryConfiguration: toWireMemoryConfiguration(
                  news.memoryConfiguration,
                ),
                tags: desiredTags,
              }),
            );
            agent = created.agent;
            agent = (yield* waitForSettled(agent.agentId)) ?? agent;
          } else {
            // 3. SYNC — wait for any in-flight transition, then update.
            agent = (yield* waitForSettled(agent.agentId)) ?? agent;
            yield* bedrock.updateAgent({
              agentId: agent.agentId,
              agentName: name,
              foundationModel: news.foundationModel,
              instruction: news.instruction,
              description: news.description,
              agentResourceRoleArn: roleArn,
              idleSessionTTLInSeconds: toWireSeconds(news.idleSessionTTL),
              customerEncryptionKeyArn: news.customerEncryptionKeyArn,
              guardrailConfiguration: news.guardrailConfiguration,
              memoryConfiguration: toWireMemoryConfiguration(
                news.memoryConfiguration,
              ),
            });
            agent = (yield* waitForSettled(agent.agentId)) ?? agent;
          }

          const agentId = agent.agentId;
          const agentArn = agent.agentArn;

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags (create-time tags
          //     only apply on first create; adoption may carry foreign tags).
          const observedTags = yield* fetchObservedTags(agentArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* bedrock.tagResource({
              resourceArn: agentArn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* bedrock.untagResource({
              resourceArn: agentArn,
              tagKeys: removed,
            });
          }

          // 4. PREPARE — compile the DRAFT so the agent is invocable and can
          //    back an alias. Bounded poll to PREPARED/FAILED.
          if (news.prepare !== false) {
            yield* bedrock.prepareAgent({ agentId });
            agent = (yield* waitForSettled(agentId)) ?? agent;
          }

          yield* session.note(agentArn);
          return {
            agentId,
            agentArn,
            agentName: name,
            agentVersion: agent.agentVersion ?? "DRAFT",
            agentResourceRoleArn: roleArn,
            roleName,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* bedrock
            .deleteAgent({
              agentId: output.agentId,
              skipResourceInUseCheck: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          // Tear down the managed execution role (absent when an explicit
          // agentResourceRoleArn was supplied). Every step tolerates a
          // partially or fully removed role.
          if (output.roleName !== undefined) {
            const roleName = output.roleName;
            yield* iam
              .deleteRolePolicy({
                RoleName: roleName,
                PolicyName: "BedrockAgentInvokeModel",
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            yield* iam
              .deleteRole({ RoleName: roleName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),
      });
    }),
  );
