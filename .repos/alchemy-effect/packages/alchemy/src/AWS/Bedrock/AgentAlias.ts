import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

/**
 * A rule pointing an alias at a specific agent version (optionally with
 * provisioned throughput). Omit `routingConfiguration` entirely to have
 * Bedrock snapshot the current DRAFT into a new version and point the alias
 * at it — the common "deploy the current agent" case.
 */
export interface AgentAliasRoutingConfig {
  /** The agent version this alias routes invocations to. */
  agentVersion?: string;
  /** The ARN of a provisioned-throughput commitment to use. */
  provisionedThroughput?: string;
}

export interface AgentAliasProps {
  /**
   * The id of the {@link Agent} this alias belongs to. Accepts an agent's
   * `agentId` output. Changing the agent triggers a replacement.
   */
  agentId: string;
  /**
   * Name of the alias (1-100 characters; letters, digits, and the
   * characters `_-`). If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing the name
   * triggers a replacement.
   */
  agentAliasName?: string;
  /**
   * A description of the alias.
   */
  description?: string;
  /**
   * Which agent version(s) the alias routes to. When omitted, Bedrock
   * snapshots the current DRAFT into a new version and routes the alias to
   * it on create.
   */
  routingConfiguration?: AgentAliasRoutingConfig[];
  /**
   * Tags to apply to the alias. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AgentAlias extends Resource<
  "AWS.Bedrock.AgentAlias",
  AgentAliasProps,
  {
    /**
     * The unique identifier of the agent the alias routes to.
     */
    agentId: string;
    /**
     * The unique identifier of the alias.
     */
    agentAliasId: string;
    /**
     * The ARN of the alias.
     */
    agentAliasArn: string;
    /**
     * Name of the alias.
     */
    agentAliasName: string;
  }
> {}

/**
 * An alias for an Amazon Bedrock {@link Agent} — a stable, invocable pointer
 * to one or more agent versions.
 *
 * An alias is what applications invoke (via `bedrock-agent-runtime`
 * `InvokeAgent`). Creating an alias with no `routingConfiguration` snapshots
 * the agent's current DRAFT into a new immutable version and routes the alias
 * to it, so redeploying an updated + prepared agent and recreating the alias
 * publishes a new version.
 *
 * @resource
 * @section Creating Aliases
 * @example Alias Pointing at the Current Agent
 * ```typescript
 * import * as Bedrock from "alchemy/AWS/Bedrock";
 *
 * const agent = yield* Bedrock.Agent("assistant", {
 *   foundationModel: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
 *   instruction: "You are a helpful assistant.",
 * });
 *
 * const alias = yield* Bedrock.AgentAlias("prod", {
 *   agentId: agent.agentId,
 * });
 * ```
 *
 * @example Alias Pinned to a Specific Version
 * ```typescript
 * const alias = yield* Bedrock.AgentAlias("prod", {
 *   agentId: agent.agentId,
 *   routingConfiguration: [{ agentVersion: "3" }],
 * });
 * ```
 */
export const AgentAlias = Resource<AgentAlias>("AWS.Bedrock.AgentAlias");

/** Alias status values indicating an in-flight transition to wait out. */
const ALIAS_TRANSIENT = new Set(["CREATING", "UPDATING"]);

export const AgentAliasProvider = () =>
  Provider.effect(
    AgentAlias,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<AgentAliasProps, "agentAliasName">,
      ) {
        return (
          props.agentAliasName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const getAliasOrUndefined = Effect.fn(function* (
        agentId: string,
        agentAliasId: string,
      ) {
        return yield* bedrock.getAgentAlias({ agentId, agentAliasId }).pipe(
          Effect.map((r) => r.agentAlias),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const findByName = Effect.fn(function* (agentId: string, name: string) {
        const pages = yield* bedrock.listAgentAliases
          .pages({ agentId })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.agentAliasSummaries ?? [])
          .find((s) => s.agentAliasName === name)?.agentAliasId;
      });

      const fetchObservedTags = Effect.fn(function* (resourceArn: string) {
        return yield* bedrock.listTagsForResource({ resourceArn }).pipe(
          Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      const waitForSettled = Effect.fn(function* (
        agentId: string,
        agentAliasId: string,
      ) {
        return yield* bedrock.getAgentAlias({ agentId, agentAliasId }).pipe(
          Effect.map((r) => r.agentAlias),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.repeat({
            schedule: Schedule.fixed("3 seconds"),
            until: (alias) =>
              alias === undefined ||
              !ALIAS_TRANSIENT.has(alias.agentAliasStatus),
            times: 40,
          }),
        );
      });

      return AgentAlias.Provider.of({
        stables: ["agentId", "agentAliasId", "agentAliasArn", "agentAliasName"],

        // Aliases are scoped to a parent agent — enumeration requires the
        // agent id, so this returns empty (the engine keys off state).
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const agentId = output?.agentId ?? olds?.agentId;
          if (agentId === undefined) return undefined;
          const aliasId =
            output?.agentAliasId ??
            (yield* findByName(
              agentId,
              output?.agentAliasName ??
                (yield* createName(id, olds ?? ({} as AgentAliasProps))),
            ));
          if (aliasId === undefined) return undefined;
          const alias = yield* getAliasOrUndefined(agentId, aliasId);
          if (alias === undefined || alias.agentAliasStatus === "DELETING") {
            return undefined;
          }
          const attrs = {
            agentId: alias.agentId,
            agentAliasId: alias.agentAliasId,
            agentAliasArn: alias.agentAliasArn,
            agentAliasName: alias.agentAliasName,
          };
          const tags = yield* fetchObservedTags(alias.agentAliasArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if ((olds?.agentId ?? undefined) !== (news?.agentId ?? undefined)) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(
            id,
            olds ?? ({} as AgentAliasProps),
          );
          const newName = yield* createName(
            id,
            news ?? ({} as AgentAliasProps),
          );
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // description, routingConfiguration, and tags converge via update.
        }),

        reconcile: Effect.fn(function* ({
          id,
          news = {} as AgentAliasProps,
          output,
          session,
        }) {
          const name = output?.agentAliasName ?? (yield* createName(id, news));
          const agentId = news.agentId;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let alias = output?.agentAliasId
            ? yield* getAliasOrUndefined(agentId, output.agentAliasId)
            : undefined;
          if (alias === undefined) {
            const foundId = yield* findByName(agentId, name);
            if (foundId !== undefined) {
              alias = yield* getAliasOrUndefined(agentId, foundId);
            }
          }

          if (alias === undefined) {
            // 2. ENSURE
            const created = yield* bedrock.createAgentAlias({
              agentId,
              agentAliasName: name,
              description: news.description,
              routingConfiguration: news.routingConfiguration,
              tags: desiredTags,
            });
            alias = created.agentAlias;
            alias =
              (yield* waitForSettled(agentId, alias.agentAliasId)) ?? alias;
          } else {
            // 3. SYNC
            alias =
              (yield* waitForSettled(agentId, alias.agentAliasId)) ?? alias;
            yield* bedrock.updateAgentAlias({
              agentId,
              agentAliasId: alias.agentAliasId,
              agentAliasName: name,
              description: news.description,
              routingConfiguration: news.routingConfiguration,
            });
            alias =
              (yield* waitForSettled(agentId, alias.agentAliasId)) ?? alias;
          }

          const agentAliasId = alias.agentAliasId;
          const agentAliasArn = alias.agentAliasArn;

          // 3b. SYNC TAGS against observed cloud tags.
          const observedTags = yield* fetchObservedTags(agentAliasArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* bedrock.tagResource({
              resourceArn: agentAliasArn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* bedrock.untagResource({
              resourceArn: agentAliasArn,
              tagKeys: removed,
            });
          }

          yield* session.note(agentAliasArn);
          return {
            agentId,
            agentAliasId,
            agentAliasArn,
            agentAliasName: name,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* bedrock
            .deleteAgentAlias({
              agentId: output.agentId,
              agentAliasId: output.agentAliasId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
