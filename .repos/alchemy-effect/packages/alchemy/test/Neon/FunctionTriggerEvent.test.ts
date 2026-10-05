import { decodeFunctionTriggerEvent } from "@/Neon/FunctionTriggerEvent";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

const payload = {
  version: 1,
  invocation_id: "occurrence",
  trigger: { type: "schedule", id: "trigger-test", name: "Nightly" },
  data: { scheduled_at: "2026-09-17T00:00:00Z" },
};
const request = (
  body: unknown,
  headers: Record<string, string> = {
    "x-neon-trigger-invocation-id": "occurrence",
  },
) =>
  new Request("https://example.test/jobs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test.effect(
  "validates the versioned schedule envelope and attested header",
  () =>
    Effect.gen(function* () {
      const event = yield* decodeFunctionTriggerEvent(
        yield* Effect.sync(() => request(payload)),
      );
      expect(event).toEqual(payload);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);

for (const [name, body, headers, status] of [
  ["missing attestation", payload, {}, 403],
  [
    "mismatched attestation",
    payload,
    { "x-neon-trigger-invocation-id": "other" },
    403,
  ],
  [
    "future version",
    { ...payload, version: 2 },
    { "x-neon-trigger-invocation-id": "occurrence" },
    400,
  ],
  [
    "unknown discriminator",
    { ...payload, trigger: { ...payload.trigger, type: "other" } },
    { "x-neon-trigger-invocation-id": "occurrence" },
    400,
  ],
] as const)
  test.effect(
    name,
    () =>
      Effect.gen(function* () {
        const result = yield* decodeFunctionTriggerEvent(
          yield* Effect.sync(() => request(body, headers)),
        ).pipe(
          Effect.as(200),
          Effect.catchTag("FunctionTriggerEventError", (error) =>
            Effect.succeed(error.status),
          ),
        );
        expect(result).toBe(status);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );
