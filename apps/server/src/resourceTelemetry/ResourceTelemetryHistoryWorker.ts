import {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { buildResourceTelemetryHistory } from "./ResourceTelemetryHistory.ts";

const HistoryMetadata = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: Schema.Number,
  bucketMs: Schema.Number,
  sampleIntervalMs: Schema.Number,
  serverPid: Schema.Number,
  sidecarPid: Schema.Option(Schema.Number),
  desktopSnapshot: Schema.Option(DesktopHostTelemetrySnapshot),
  health: ResourceTelemetryHealth,
});

export const encodeHistoryMetadata = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(HistoryMetadata)),
);
const decodeHistoryInput = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.toCodecJson(
      Schema.Struct({
        ...HistoryMetadata.fields,
        snapshots: Schema.Array(ResourceMonitorSnapshotEvent),
      }),
    ),
  ),
);
const HistoryResult = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      ...ResourceTelemetryHistory.fields,
      legacyBackendBuckets: Schema.Array(ResourceTelemetryHistoryBucket),
    }),
  ),
);
export const decodeHistoryResult = Schema.decodeSync(HistoryResult);
const encodeHistoryResult = Schema.encodeSync(HistoryResult);

export async function runResourceTelemetryHistoryWorker(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const history = buildResourceTelemetryHistory(
    decodeHistoryInput(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(encodeHistoryResult(history));
}
