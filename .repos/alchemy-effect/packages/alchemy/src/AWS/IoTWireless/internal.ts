import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Effect from "effect/Effect";
import { diffTags, tagRecord } from "../../Tags.ts";

/**
 * Read the observed tags for any IoT Wireless resource ARN. Tag reads are
 * best-effort — a race with deletion (or a missing-tags edge) degrades to an
 * empty record rather than failing the lifecycle operation.
 */
export const readIotWirelessTags = (arn: string) =>
  iotw.listTagsForResource({ ResourceArn: arn }).pipe(
    Effect.map((r) => tagRecord(r.Tags ?? [])),
    Effect.catch(() => Effect.succeed<Record<string, string>>({})),
  );

/**
 * Converge the tags on an IoT Wireless resource to `desired`, diffing against
 * the OBSERVED cloud tags so adoption converges.
 */
export const syncIotWirelessTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const current = yield* readIotWirelessTags(arn);
  const { upsert, removed } = diffTags(current, desired);
  if (upsert.length > 0) {
    yield* iotw.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* iotw.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

/**
 * Deep structural equality on JSON-ish values with key order and
 * `undefined`-valued members normalized away. Used to compare desired
 * LoRaWAN config structs against observed cloud state.
 */
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
};

export const sameShape = (l: unknown, r: unknown) =>
  JSON.stringify(normalize(l)) === JSON.stringify(normalize(r));
