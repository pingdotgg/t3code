import type { ResourceAttributionEntry, ResourceAttributionSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface ResourceAttributionRecord {
  readonly component: string;
  readonly operation: string;
  readonly logicalReadBytes?: number;
  readonly logicalWriteBytes?: number;
  readonly count?: number;
  readonly durationMs?: number;
}

export interface ResourceAttributionShape {
  readonly record: (input: ResourceAttributionRecord) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<ResourceAttributionSnapshot>;
}

export class ResourceAttribution extends Context.Service<
  ResourceAttribution,
  ResourceAttributionShape
>()("t3/resourceTelemetry/ResourceAttribution") {}

function key(input: Pick<ResourceAttributionRecord, "component" | "operation">): string {
  return `${input.component}\u0000${input.operation}`;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export const make = Effect.fn("resourceTelemetry.resourceAttribution.make")(function* () {
  const entries = yield* Ref.make(new Map<string, ResourceAttributionEntry>());

  const record: ResourceAttributionShape["record"] = (input) =>
    Ref.update(entries, (current) => {
      const next = new Map(current);
      const entryKey = key(input);
      const existing = next.get(entryKey);
      next.set(entryKey, {
        component: input.component,
        operation: input.operation,
        logicalReadBytes:
          (existing?.logicalReadBytes ?? 0) + nonNegativeInteger(input.logicalReadBytes, 0),
        logicalWriteBytes:
          (existing?.logicalWriteBytes ?? 0) + nonNegativeInteger(input.logicalWriteBytes, 0),
        count: (existing?.count ?? 0) + nonNegativeInteger(input.count, 1),
        durationMs: (existing?.durationMs ?? 0) + nonNegativeInteger(input.durationMs, 0),
      });
      return next;
    });

  return ResourceAttribution.of({
    record,
    snapshot: Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const current = yield* Ref.get(entries);
      return {
        readAt,
        entries: [...current.values()].toSorted(
          (left, right) => right.logicalWriteBytes - left.logicalWriteBytes,
        ),
      };
    }),
  });
});

export const layer = Layer.effect(ResourceAttribution, make());
