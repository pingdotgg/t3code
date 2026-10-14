import {
  GenerationSpeedMeasurement,
  type GenerationSpeedBucket,
  type GenerationSpeedHistory as History,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

/** Optional for usage readers that run without T3's orchestration database. */
export class GenerationSpeedHistory extends Context.Reference<{
  readonly read: (input: UsageSummaryInput) => Effect.Effect<History | undefined, UsageReadError>;
}>("t3/usage/GenerationSpeedHistory", {
  defaultValue: () => ({ read: () => Effect.undefined }),
}) {}

const Marker = Schema.Struct({ sourceId: Schema.String, trackingStartedAt: Schema.String });
const MarkerJson = Schema.fromJsonString(Marker);
const MeasurementJson = Schema.fromJsonString(GenerationSpeedMeasurement);
const decodeMarker = Schema.decodeEffect(MarkerJson);
const encodeMarker = Schema.encodeEffect(MarkerJson);
const decodeMeasurement = Schema.decodeEffect(MeasurementJson);

/** Groups only measured responses, keeping their matched tokens and seconds together. */
export function aggregateGenerationSpeed(
  measurements: readonly GenerationSpeedMeasurement[],
  input: UsageSummaryInput,
): readonly GenerationSpeedBucket[] {
  const formatDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const buckets = new Map<string, GenerationSpeedBucket>();
  for (const measurement of measurements) {
    // @effect-diagnostics-next-line globalDate:off -- buckets supplied timestamps in the requested timezone.
    const at = new Date(measurement.startedAt);
    if (
      !Number.isFinite(at.getTime()) ||
      measurement.durationMs <= 0 ||
      measurement.outputTokens <= 0
    )
      continue;
    const day = formatDay.format(at);
    if (day < input.sinceDay || day > input.untilDay) continue;
    if (
      input.resolution === "hour" &&
      (at.getTime() < Date.parse(input.sinceTime!) || at.getTime() >= Date.parse(input.untilTime!))
    )
      continue;
    const hourStart =
      input.resolution === "hour"
        ? // @effect-diagnostics-next-line globalDate:off -- formats a supplied timestamp.
          new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString()
        : undefined;
    const key = JSON.stringify([
      day,
      hourStart,
      measurement.provider,
      measurement.model,
      measurement.reasoningEffort,
      measurement.serviceTier,
    ]);
    const previous = buckets.get(key);
    buckets.set(key, {
      ...measurement,
      day,
      ...(hourStart === undefined ? {} : { hourStart }),
      outputTokens: (previous?.outputTokens ?? 0) + measurement.outputTokens,
      durationMs: (previous?.durationMs ?? 0) + measurement.durationMs,
      responses: (previous?.responses ?? 0) + measurement.responses,
      startedAt:
        previous && previous.startedAt < measurement.startedAt
          ? previous.startedAt
          : measurement.startedAt,
    });
  }
  return [...buckets.values()];
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(config.stateDir, "generation-speed-tracking.json");
  const marker = yield* Effect.gen(function* () {
    if (yield* fs.exists(markerPath)) {
      return yield* decodeMarker(yield* fs.readFileString(markerPath));
    }
    const value = {
      sourceId: yield* randomUuidV4,
      trackingStartedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* writeFileStringAtomically({
      filePath: markerPath,
      contents: yield* encodeMarker(value),
    });
    return value;
  }).pipe(Effect.orDie);

  const read = Effect.fn("GenerationSpeedHistory.read")(function* (input: UsageSummaryInput) {
    // Broad UTC bounds accommodate every reporting timezone without scanning
    // payloads outside the window. Exact day/hour filtering follows decoding.
    const since = DateTime.formatIso(
      DateTime.subtract(DateTime.makeUnsafe(`${input.sinceDay}T00:00:00Z`), { days: 1 }),
    );
    const until = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(`${input.untilDay}T00:00:00Z`), { days: 2 }),
    );
    const rows = yield* sql<{ measurement: string }>`
      SELECT json_extract(payload_json, '$.generationSpeed') AS measurement
      FROM orchestration_v2_projection_provider_turns
      WHERE completed_at >= ${since} AND started_at < ${until}
        AND run_attempt_id IS NOT NULL
        AND json_type(payload_json, '$.generationSpeed') = 'object'
    `.pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read generation speed history.",
            cause,
          }),
      ),
    );
    const measurements = yield* Effect.forEach(rows, (row) =>
      decodeMeasurement(row.measurement).pipe(
        Effect.mapError(
          (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Could not decode generation speed history.",
              cause,
            }),
        ),
      ),
    );
    return { ...marker, buckets: aggregateGenerationSpeed(measurements, input) };
  });
  return { read };
});

export const layer = Layer.effect(GenerationSpeedHistory, make);
