import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import type { ResourceClass, ResourceLike } from "../../Resource.ts";

/**
 * Shared helpers for the Prisma providers' local (`alchemy dev`) variants.
 * Local variants fabricate deterministic `dev:`-prefixed identifiers and
 * never talk to the Prisma Management API.
 */

export type DevRecord = Record<string, unknown>;

export const DEV_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const devId = (type: string, id: string) => `dev:${type}:${id}`;

export const isRecord = (value: unknown): value is DevRecord =>
  typeof value === "object" && value !== null;

const attr = (value: unknown, key: string) =>
  isRecord(value) ? value[key] : undefined;

export const attrOrString = (value: unknown, attrName: string) =>
  typeof value === "string"
    ? value
    : isRecord(value) && typeof value[attrName] === "string"
      ? value[attrName]
      : undefined;

export const attrOrNullableString = (value: unknown, key: string) => {
  const candidate = attr(value, key);
  return candidate === null || typeof candidate === "string"
    ? candidate
    : undefined;
};

export const attrOrRedactedString = (value: unknown, key: string) => {
  const candidate = attr(value, key);
  return Redacted.isRedacted(candidate)
    ? Redacted.make(String(Redacted.value(candidate)))
    : typeof candidate === "string"
      ? Redacted.make(candidate)
      : undefined;
};

/**
 * Build a stateless local provider stub: reconcile merges the previous
 * outputs with freshly fabricated attributes, read echoes persisted state,
 * and delete is a no-op.
 */
export const devProvider = <R extends ResourceLike>(
  resource: ResourceClass<R>,
  stables: Extract<keyof R["Attributes"], string>[],
  attrs: (input: {
    id: string;
    news: DevRecord;
    output?: DevRecord;
  }) => DevRecord,
) =>
  Provider.succeed(resource, {
    stables,
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const newsRecord = isRecord(news) ? news : {};
      const outputRecord = isRecord(output) ? output : undefined;
      return {
        ...outputRecord,
        ...attrs({ id, news: newsRecord, output: outputRecord }),
      } as R["Attributes"];
    }),
    delete: Effect.fn(function* () {}),
  });
