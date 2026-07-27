import * as control from "@distilled.cloud/aws/bedrock-agentcore-control";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import {
  AgentCoreProvisioningFailed,
  createAgentCoreName,
  readAgentCoreTags,
  retryWhileConflict,
  syncAgentCoreTags,
  unredact,
} from "./internal.ts";

/**
 * A single long-term memory extraction strategy (semantic, summary, user
 * preference, episodic, or custom). Passed through to the AgentCore API
 * unchanged — see the AWS SDK `MemoryStrategyInput` shape.
 */
export type MemoryStrategy = control.MemoryStrategyInput;

export interface MemoryProps {
  /**
   * Name of the memory. Must match `[a-zA-Z][a-zA-Z0-9_]{0,47}` (underscores,
   * no hyphens). If omitted, a deterministic physical name is generated from
   * the app, stage, and logical ID. Changing the name triggers a replacement.
   */
  name?: string;
  /**
   * A description of the memory.
   */
  description?: string;
  /**
   * How long until short-term memory events expire (7-365 days), e.g.
   * `"30 days"` or `Duration.days(30)` (a bare number is milliseconds).
   * @default 90 days
   */
  eventExpiryDuration?: Duration.Input;
  /**
   * The ARN of a KMS key used to encrypt the memory. Changing it triggers a
   * replacement.
   */
  encryptionKeyArn?: string;
  /**
   * The ARN of an IAM role AgentCore Memory assumes to run long-term
   * extraction strategies. Required when `memoryStrategies` use managed
   * extraction models.
   */
  memoryExecutionRoleArn?: string;
  /**
   * Long-term memory extraction strategies. Create-only: changing the
   * strategy list triggers a replacement (in-place strategy modification is
   * not reconciled).
   */
  memoryStrategies?: MemoryStrategy[];
  /**
   * Tags to apply to the memory. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Memory extends Resource<
  "AWS.BedrockAgentCore.Memory",
  MemoryProps,
  {
    /**
     * The unique identifier of the memory.
     */
    memoryId: string;
    /**
     * The ARN of the memory.
     */
    memoryArn: string;
    /**
     * Name of the memory.
     */
    name: string;
    /**
     * Current status of the memory (e.g. `ACTIVE`).
     */
    status: string;
  }
> {}

/**
 * An Amazon Bedrock AgentCore Memory — managed short- and long-term memory
 * for AI agents.
 *
 * Short-term memory stores raw session events (turn-by-turn conversation);
 * optional `memoryStrategies` asynchronously extract long-term records
 * (semantic facts, summaries, user preferences) into queryable namespaces.
 *
 * Provisioning is asynchronous: the provider waits for the memory to reach
 * `ACTIVE` (~2-3 minutes) before returning.
 *
 * @resource
 * @section Creating Memories
 * @example Short-Term Memory Only
 * ```typescript
 * import * as AgentCore from "alchemy/AWS/BedrockAgentCore";
 *
 * const memory = yield* AgentCore.Memory("SessionMemory", {
 *   eventExpiryDuration: "30 days",
 * });
 * ```
 *
 * @example Memory with a Semantic Long-Term Strategy
 * ```typescript
 * const memory = yield* AgentCore.Memory("AgentMemory", {
 *   eventExpiryDuration: "90 days",
 *   memoryStrategies: [
 *     {
 *       semanticMemoryStrategy: {
 *         name: "facts",
 *         namespaces: ["facts/{actorId}"],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Using Memory from a Function
 * @example Record and Query Events
 * ```typescript
 * // init
 * const createEvent = yield* AgentCore.CreateEvent(memory);
 * const listEvents = yield* AgentCore.ListEvents(memory);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* createEvent({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *       eventTimestamp: new Date(),
 *       payload: [
 *         {
 *           conversational: {
 *             role: "USER",
 *             content: { text: "My favorite color is teal." },
 *           },
 *         },
 *       ],
 *     });
 *     const events = yield* listEvents({
 *       actorId: "user-1",
 *       sessionId: "session-1",
 *     });
 *     return HttpServerResponse.json({ count: events.events.length });
 *   }),
 * };
 * ```
 */
export const Memory = Resource<Memory>("AWS.BedrockAgentCore.Memory");

/** Statuses indicating an in-flight transition to wait out. */
const MEMORY_TRANSIENT = new Set(["CREATING", "UPDATING"]);

export const MemoryProvider = () =>
  Provider.effect(
    Memory,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<MemoryProps, "name">,
      ) {
        return props.name ?? (yield* createAgentCoreName(id));
      });

      const getMemoryOrUndefined = Effect.fn(function* (memoryId: string) {
        return yield* control.getMemory({ memoryId }).pipe(
          Effect.map((r) => r.memory),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      // Memory summaries carry no name, so find-by-name hydrates each
      // non-deleting summary and matches on the fetched name.
      const findByName = Effect.fn(function* (name: string) {
        const pages = yield* control.listMemories
          .pages({})
          .pipe(Stream.runCollect);
        const summaries = Array.from(pages).flatMap(
          (page) => page.memories ?? [],
        );
        const hydrated = yield* Effect.forEach(
          summaries,
          (s) =>
            s.id === undefined || s.status === "DELETING"
              ? Effect.succeed(undefined)
              : getMemoryOrUndefined(s.id),
          { concurrency: 5 },
        );
        return hydrated.find((m) => m !== undefined && m.name === name);
      });

      const waitForSettled = Effect.fn(function* (memoryId: string) {
        return yield* getMemoryOrUndefined(memoryId).pipe(
          Effect.repeat({
            schedule: Schedule.fixed("5 seconds"),
            until: (m) => m === undefined || !MEMORY_TRANSIENT.has(m.status),
            times: 60,
          }),
        );
      });

      const toAttributes = (memory: control.Memory) => ({
        memoryId: memory.id,
        memoryArn: memory.arn,
        name: memory.name,
        status: memory.status,
      });

      return Memory.Provider.of({
        stables: ["memoryId", "memoryArn", "name"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* control.listMemories
              .pages({})
              .pipe(Stream.runCollect);
            const summaries = Array.from(pages).flatMap(
              (page) => page.memories ?? [],
            );
            const hydrated = yield* Effect.forEach(
              summaries,
              (s) =>
                s.id === undefined || s.status === "DELETING"
                  ? Effect.succeed(undefined)
                  : getMemoryOrUndefined(s.id),
              { concurrency: 5 },
            );
            return hydrated.filter((m) => m !== undefined).map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const memory = output?.memoryId
            ? yield* getMemoryOrUndefined(output.memoryId)
            : yield* findByName(
                yield* createName(id, olds ?? ({} as MemoryProps)),
              );
          if (memory === undefined || memory.status === "DELETING") {
            return undefined;
          }
          const attrs = toAttributes(memory);
          const tags = yield* readAgentCoreTags(memory.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldProps = olds ?? ({} as MemoryProps);
          const oldName = yield* createName(id, oldProps);
          const newName = yield* createName(id, news ?? ({} as MemoryProps));
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            (oldProps.encryptionKeyArn ?? undefined) !==
            (news?.encryptionKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          // Strategy lists are create-only: in-place strategy mutation uses a
          // different (Modify) input shape and partial updates — replace.
          if (
            JSON.stringify(oldProps.memoryStrategies ?? []) !==
            JSON.stringify(news?.memoryStrategies ?? [])
          ) {
            return { action: "replace" } as const;
          }
          // description / eventExpiryDuration / execution role / tags converge
          // via update.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? ({} as MemoryProps);
          const name = output?.name ?? (yield* createName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };
          const eventExpiryDuration =
            toWireDays(props.eventExpiryDuration) ?? 90;

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let memory = output?.memoryId
            ? yield* getMemoryOrUndefined(output.memoryId)
            : undefined;
          if (memory === undefined) {
            memory = yield* findByName(name);
          }

          // 2. ENSURE — create if missing; tolerate the name-exists race.
          if (memory === undefined) {
            const created = yield* control
              .createMemory({
                name,
                description: props.description,
                eventExpiryDuration,
                encryptionKeyArn: props.encryptionKeyArn,
                memoryExecutionRoleArn: props.memoryExecutionRoleArn,
                memoryStrategies: props.memoryStrategies,
                tags: desiredTags,
              })
              .pipe(
                Effect.map((r) => r.memory),
                Effect.catchTag("ConflictException", () => findByName(name)),
              );
            memory = created ?? (yield* findByName(name));
          }
          if (memory === undefined) {
            return yield* new AgentCoreProvisioningFailed({
              message: `memory '${name}' was neither created nor found`,
            });
          }

          // Wait out CREATING/UPDATING (~2-3 minutes on create).
          memory = (yield* waitForSettled(memory.id)) ?? memory;
          if (memory.status === "FAILED") {
            return yield* new AgentCoreProvisioningFailed({
              message: `memory '${name}' failed: ${memory.failureReason ?? "unknown"}`,
            });
          }

          // 3. SYNC — converge mutable settings from OBSERVED state.
          const drifted =
            (unredact(memory.description) ?? undefined) !==
              (props.description ?? unredact(memory.description)) ||
            memory.eventExpiryDuration !== eventExpiryDuration ||
            (memory.memoryExecutionRoleArn ?? undefined) !==
              (props.memoryExecutionRoleArn ?? memory.memoryExecutionRoleArn);
          if (drifted) {
            yield* control.updateMemory({
              memoryId: memory.id,
              description: props.description,
              eventExpiryDuration,
              memoryExecutionRoleArn: props.memoryExecutionRoleArn,
            });
            memory = (yield* waitForSettled(memory.id)) ?? memory;
          }

          // 3b. SYNC TAGS against observed cloud tags.
          yield* syncAgentCoreTags(memory.arn, desiredTags);

          // 4. RETURN fresh attributes.
          yield* session.note(memory.id);
          return toAttributes(memory);
        }),

        // Deletion is initiated with deleteMemory and completes server-side in
        // ~30s. Wait until fully gone so an immediate re-create of the same
        // name cannot hit the lingering DELETING record.
        delete: Effect.fn(function* ({ output }) {
          yield* control.deleteMemory({ memoryId: output.memoryId }).pipe(
            retryWhileConflict,
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          yield* control.getMemory({ memoryId: output.memoryId }).pipe(
            Effect.map((r) => r.memory.status as string),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("GONE" as string),
            ),
            Effect.repeat({
              schedule: Schedule.fixed("5 seconds"),
              until: (status) => status === "GONE",
              times: 36,
            }),
          );
        }),
      });
    }),
  );
