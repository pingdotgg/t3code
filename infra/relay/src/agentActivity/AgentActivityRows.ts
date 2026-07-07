import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../persistence/schema.ts";

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedErrorClass<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    readonly upsert: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError>;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
  }
>()("t3code-relay/agentActivity/AgentActivityRows") {}

const decodeJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJsonValue = Schema.encodeEffect(Schema.UnknownFromJsonString);

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.state.environmentId,
        "relay.thread_id": input.state.threadId,
      });
      const now = yield* DateTime.now;
      const stateJson = yield* encodeRelayAgentActivityStateJson(input.state).pipe(
        Effect.flatMap(decodeJsonString),
        Effect.map(Function.cast<unknown, RelayAgentActivityState>),
        Effect.mapError(
          (cause) =>
            new AgentActivityRowUpsertPersistenceError({
              environmentId: input.state.environmentId,
              threadId: input.state.threadId,
              cause,
            }),
        ),
      );
      yield* db
        .insert(relayAgentActivityRows)
        .values({
          environmentId: input.state.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          threadId: input.state.threadId,
          stateJson,
          updatedAt: input.state.updatedAt,
          createdAt: DateTime.formatIso(now),
        })
        .onConflictDoUpdate({
          target: [
            relayAgentActivityRows.environmentId,
            relayAgentActivityRows.environmentPublicKey,
            relayAgentActivityRows.threadId,
          ],
          set: {
            stateJson,
            updatedAt: input.state.updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowUpsertPersistenceError({
                environmentId: input.state.environmentId,
                threadId: input.state.threadId,
                cause,
              }),
          ),
        );
    }),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowDeletePersistenceError({
                environmentId: input.environmentId,
                threadId: input.threadId,
                cause,
              }),
          ),
        );
    }),

    pruneTerminal: Effect.fn("relay.agent_activity_rows.prune_terminal")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.agent_activity_prune.before": input.updatedBefore,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            sql`${relayAgentActivityRows.stateJson} ->> 'phase' IN ('completed', 'failed')`,
            lt(relayAgentActivityRows.updatedAt, input.updatedBefore),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowPruneTerminalPersistenceError({
                updatedBefore: input.updatedBefore,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => encodeJsonValue(row.stateJson), {
              concurrency: "unbounded",
            }),
          ),
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityStateJson(row))),
          ),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);
