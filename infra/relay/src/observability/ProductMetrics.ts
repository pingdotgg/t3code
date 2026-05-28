import * as Effect from "effect/Effect";
import { and, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { RelayDatabase } from "../db.ts";
import {
  relayAgentActivityRows,
  relayEnvironmentLinks,
  relayLiveActivities,
  relayMobileDevices,
} from "../schema.ts";
import {
  relayAgentActivitiesActive,
  relayEnvironmentLinksActive,
  relayLiveActivityTargetsActive,
  relayManagedTunnelsActive,
  relayMobileDevicesRegistered,
  updateGauge,
} from "./Metrics.ts";

function rowCount(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10);
  }
  return 0;
}

export const recordRelayProductStateMetrics = (db: RelayDatabase) =>
  Effect.gen(function* () {
    const countExpression = sql<number>`count(*)::int`;

    const [
      activeLinks,
      activeManagedTunnels,
      registeredMobileDevices,
      activeLiveActivities,
      activeAgentActivities,
    ] = yield* Effect.all(
      [
        db
          .select({ count: countExpression })
          .from(relayEnvironmentLinks)
          .where(isNull(relayEnvironmentLinks.revokedAt)),
        db
          .select({ count: countExpression })
          .from(relayEnvironmentLinks)
          .where(
            and(
              isNull(relayEnvironmentLinks.revokedAt),
              sql`${relayEnvironmentLinks.managedTunnelsEnabled} = true`,
            ),
          ),
        db.select({ count: countExpression }).from(relayMobileDevices),
        db
          .select({ count: countExpression })
          .from(relayLiveActivities)
          .where(
            and(
              isNull(relayLiveActivities.endedAt),
              or(
                isNotNull(relayLiveActivities.remoteStartQueuedAt),
                isNotNull(relayLiveActivities.remoteStartedAt),
                isNotNull(relayLiveActivities.activityPushToken),
              ),
            ),
          ),
        db.select({ count: countExpression }).from(relayAgentActivityRows),
      ],
      { concurrency: 5 },
    );

    yield* updateGauge(relayEnvironmentLinksActive, {}, rowCount(activeLinks[0]?.count));
    yield* updateGauge(relayManagedTunnelsActive, {}, rowCount(activeManagedTunnels[0]?.count));
    yield* updateGauge(
      relayMobileDevicesRegistered,
      {},
      rowCount(registeredMobileDevices[0]?.count),
    );
    yield* updateGauge(
      relayLiveActivityTargetsActive,
      {},
      rowCount(activeLiveActivities[0]?.count),
    );
    yield* updateGauge(relayAgentActivitiesActive, {}, rowCount(activeAgentActivities[0]?.count));
  }).pipe(
    Effect.catch((cause: unknown) =>
      Effect.logWarning("relay product metric snapshot failed", { cause }).pipe(Effect.asVoid),
    ),
  );
