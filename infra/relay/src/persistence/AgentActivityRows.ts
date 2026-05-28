import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, desc, eq, isNull } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../schema.ts";
import { parseJsonString, stringifyJsonValue } from "./json.ts";

export class AgentActivityRowUpsertPersistenceError extends Data.TaggedError(
  "AgentActivityRowUpsertPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class AgentActivityRowDeletePersistenceError extends Data.TaggedError(
  "AgentActivityRowDeletePersistenceError",
)<{
  readonly cause: unknown;
}> {}

export class AgentActivityRowListPersistenceError extends Data.TaggedError(
  "AgentActivityRowListPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export interface AgentActivityRowsShape {
  readonly upsert: (input: {
    readonly environmentPublicKey: string;
    readonly state: RelayAgentActivityState;
  }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError>;
  readonly remove: (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly threadId: string;
  }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
  readonly listForUser: (input: {
    readonly userId: string;
  }) => Effect.Effect<ReadonlyArray<RelayAgentActivityState>, AgentActivityRowListPersistenceError>;
}

export class AgentActivityRows extends Context.Service<AgentActivityRows, AgentActivityRowsShape>()(
  "AgentActivityRows",
) {}

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  return AgentActivityRows.of({
    upsert: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const stateJson = yield* parseJsonString<RelayAgentActivityState>(
          yield* encodeRelayAgentActivityStateJson(input.state),
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
          });
      }).pipe(Effect.mapError((cause) => new AgentActivityRowUpsertPersistenceError({ cause }))),

    remove: (input) =>
      db
        .delete(relayAgentActivityRows)
        .where(
          and(
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .pipe(Effect.mapError((cause) => new AgentActivityRowDeletePersistenceError({ cause }))),

    listForUser: (input) =>
      db
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
            Effect.forEach(rows, (row) => stringifyJsonValue(row.stateJson), {
              concurrency: "unbounded",
            }),
          ),
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityStateJson(row))),
          ),
          Effect.mapError((cause) => new AgentActivityRowListPersistenceError({ cause })),
        ),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);
