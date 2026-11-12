/**
 * Local Flagship simulator: flag definitions are written from Node with
 * `Flagship.writeFlag` (as alchemy's local Flag provider does) while the
 * test worker is running, and evaluated through `Flagship.local` bindings.
 */
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Flagship from "../../bindings/flagship/index.ts";
import * as Storage from "../../globals/Storage.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const TEST_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/eval") {
      const { binding = "FLAGS", method, key, defaultValue, context } = await request.json();
      const result = await env[binding][method](key, defaultValue, context);
      return Response.json({ result });
    }
    return new Response(null, { status: 404 });
  },
};
`;

const modules = [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }] as const;

const start = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [...modules],
    bindings: [
      Flagship.local({ binding: "FLAGS", appId: "app-a" }),
      Flagship.local({ binding: "OTHER", appId: "app-b" }),
    ],
  });

const store = Effect.gen(function* () {
  const storage = yield* Storage.Storage;
  return { storageDirectory: storage.disk!.path, appId: "app-a" };
});

const seed = (_worker: TestWorker, key: string, flag: Flagship.FlagshipFlagDefinition | null) =>
  Effect.gen(function* () {
    const app = yield* store;
    yield* flag === null ? Flagship.deleteFlag(app, key) : Flagship.writeFlag(app, key, flag);
  }).pipe(Effect.orDie);

const evaluate = <T = unknown>(
  worker: TestWorker,
  input: {
    method: string;
    key: string;
    defaultValue?: unknown;
    context?: Record<string, unknown>;
    binding?: string;
  },
) =>
  worker
    .fetchJson<{ result: T }>("/eval", { method: "POST", body: JSON.stringify(input) })
    .pipe(Effect.map(({ result }) => result));

const booleanFlag = (
  overrides: Partial<Flagship.FlagshipFlagDefinition> = {},
): Flagship.FlagshipFlagDefinition => ({
  enabled: true,
  defaultVariation: "off",
  variations: { off: false, on: true },
  rules: [],
  ...overrides,
});

layer(localRuntimeLayer)("Flagship binding", (it) => {
  it.effect("evaluates seeded flags and reports evaluation reasons", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-reasons-test");

      expect(
        yield* evaluate(worker, { method: "getBooleanDetails", key: "f", defaultValue: true }),
      ).toMatchObject({ flagKey: "f", value: true, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });

      yield* seed(worker, "f", booleanFlag());
      expect(
        yield* evaluate(worker, { method: "getBooleanDetails", key: "f", defaultValue: true }),
      ).toMatchObject({ value: false, variant: "off", reason: "STATIC" });

      yield* seed(
        worker,
        "f",
        booleanFlag({
          rules: [
            {
              priority: 1,
              conditions: [{ attribute: "country", operator: "equals", value: "US" }],
              serveVariation: "on",
            },
          ],
        }),
      );
      expect(
        yield* evaluate(worker, {
          method: "getBooleanDetails",
          key: "f",
          defaultValue: false,
          context: { country: "US" },
        }),
      ).toMatchObject({ value: true, variant: "on", reason: "TARGETING_MATCH" });
      expect(
        yield* evaluate(worker, {
          method: "getBooleanDetails",
          key: "f",
          defaultValue: false,
          context: { country: "CA" },
        }),
      ).toMatchObject({ value: false, variant: "off", reason: "DEFAULT" });

      yield* seed(worker, "f", booleanFlag({ enabled: false, defaultVariation: "on" }));
      expect(
        yield* evaluate(worker, {
          method: "getBooleanDetails",
          key: "f",
          defaultValue: false,
          context: { country: "US" },
        }),
      ).toMatchObject({ value: true, reason: "DISABLED" });

      // Deleting a flag makes it unknown again.
      yield* seed(worker, "f", null);
      expect(
        yield* evaluate(worker, { method: "getBooleanValue", key: "f", defaultValue: true }),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("typed methods fall back to the default on a type mismatch", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-types-test");
      yield* seed(worker, "flow", {
        enabled: true,
        defaultVariation: "v2",
        variations: { v1: "classic", v2: "express" },
        rules: [],
      });
      yield* seed(worker, "theme", {
        enabled: true,
        defaultVariation: "dark",
        variations: { dark: { bg: "#000" } },
        rules: [],
      });

      expect(
        yield* evaluate(worker, { method: "getStringValue", key: "flow", defaultValue: "x" }),
      ).toBe("express");
      expect(yield* evaluate(worker, { method: "get", key: "flow" })).toBe("express");
      expect(
        yield* evaluate(worker, { method: "getBooleanDetails", key: "flow", defaultValue: false }),
      ).toMatchObject({ value: false, reason: "ERROR", errorCode: "TYPE_MISMATCH" });
      expect(
        yield* evaluate(worker, { method: "getObjectValue", key: "theme", defaultValue: {} }),
      ).toEqual({ bg: "#000" });
      expect(
        yield* evaluate(worker, { method: "getNumberValue", key: "theme", defaultValue: 7 }),
      ).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("matches operators, nested paths and condition groups", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-operators-test");
      const match = (condition: Flagship.FlagshipCondition, context: Record<string, unknown>) =>
        Effect.gen(function* () {
          yield* seed(
            worker,
            "op",
            booleanFlag({
              rules: [{ priority: 1, conditions: [condition], serveVariation: "on" }],
            }),
          );
          return yield* evaluate<boolean>(worker, {
            method: "getBooleanValue",
            key: "op",
            defaultValue: false,
            context,
          });
        });

      expect(
        yield* match({ attribute: "age", operator: "greater_than", value: 18 }, { age: 21 }),
      ).toBe(true);
      expect(
        yield* match({ attribute: "age", operator: "less_than", value: 18 }, { age: 21 }),
      ).toBe(false);
      expect(
        yield* match(
          { attribute: "createdAt", operator: "less_than", value: "2026-01-01T00:00:00Z" },
          { createdAt: "2025-06-01T00:00:00Z" },
        ),
      ).toBe(true);
      expect(
        yield* match(
          { attribute: "email", operator: "ends_with", value: "@cloudflare.com" },
          { email: "a@cloudflare.com" },
        ),
      ).toBe(true);
      expect(
        yield* match(
          { attribute: "country", operator: "in", value: ["US", "CA"] },
          { country: "CA" },
        ),
      ).toBe(true);
      expect(
        yield* match({ attribute: "tags", operator: "has", value: "beta" }, { tags: ["beta"] }),
      ).toBe(true);
      expect(
        yield* match(
          { attribute: "profile.plan", operator: "equals", value: "pro" },
          {
            profile: { plan: "pro" },
          },
        ),
      ).toBe(true);
      // A literal top-level key wins over nested traversal.
      expect(
        yield* match(
          { attribute: "profile.plan", operator: "equals", value: "pro" },
          {
            "profile.plan": "free",
            profile: { plan: "pro" },
          },
        ),
      ).toBe(false);
      // Missing attributes never match, even negative operators.
      expect(yield* match({ attribute: "plan", operator: "not_equals", value: "free" }, {})).toBe(
        false,
      );
      // A null attribute matches only not_equals / not_in.
      expect(
        yield* match({ attribute: "plan", operator: "not_equals", value: "free" }, { plan: null }),
      ).toBe(true);
      expect(
        yield* match(
          {
            logicalOperator: "AND",
            clauses: [
              { attribute: "plan", operator: "equals", value: "enterprise" },
              {
                logicalOperator: "OR",
                clauses: [
                  { attribute: "country", operator: "equals", value: "US" },
                  { attribute: "country", operator: "equals", value: "CA" },
                ],
              },
            ],
          },
          { plan: "enterprise", country: "CA" },
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("percentage rollouts are sticky and split by percentage", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-rollout-test");
      yield* seed(
        worker,
        "rollout",
        booleanFlag({
          rules: [
            { priority: 1, conditions: [], serveVariation: "on", rollout: { percentage: 50 } },
          ],
        }),
      );
      const users = Array.from({ length: 200 }, (_, i) => `user-${i}`);
      const first = yield* Effect.forEach(users, (targetingKey) =>
        evaluate<{ value: boolean; reason: string }>(worker, {
          method: "getBooleanDetails",
          key: "rollout",
          defaultValue: false,
          context: { targetingKey },
        }),
      );
      const second = yield* Effect.forEach(users, (targetingKey) =>
        evaluate<{ value: boolean }>(worker, {
          method: "getBooleanDetails",
          key: "rollout",
          defaultValue: false,
          context: { targetingKey },
        }),
      );
      expect(second.map((d) => d.value)).toEqual(first.map((d) => d.value));
      const on = first.filter((d) => d.value);
      expect(on.every((d) => d.reason === "SPLIT")).toBe(true);
      expect(on.length).toBeGreaterThan(60);
      expect(on.length).toBeLessThan(140);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an invalid context", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-context-test");
      yield* seed(worker, "f", booleanFlag());
      // JSON can't carry NaN, so send a value that fails validation by shape:
      // a non-object context.
      const details = yield* worker
        .fetchJson<{ result: Record<string, unknown> }>("/eval", {
          method: "POST",
          body: JSON.stringify({
            method: "getBooleanDetails",
            key: "f",
            defaultValue: true,
            context: ["not", "an", "object"],
          }),
        })
        .pipe(Effect.map(({ result }) => result));
      expect(details).toMatchObject({ value: true, reason: "ERROR", errorCode: "INVALID_CONTEXT" });
    }).pipe(Effect.scoped),
  );

  it.effect("apps are isolated from each other", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-isolation-test");
      yield* seed(worker, "shared", booleanFlag({ defaultVariation: "on" }));
      expect(
        yield* evaluate(worker, { method: "getBooleanValue", key: "shared", defaultValue: false }),
      ).toBe(true);
      expect(
        yield* evaluate(worker, {
          binding: "OTHER",
          method: "getBooleanDetails",
          key: "shared",
          defaultValue: false,
        }),
      ).toMatchObject({ errorCode: "FLAG_NOT_FOUND" });
    }).pipe(Effect.scoped),
  );
  it.effect("Node-side evaluation matches the binding", () =>
    Effect.gen(function* () {
      const worker = yield* start("flagship-node-test");
      const app = yield* store;
      yield* seed(
        worker,
        "n",
        booleanFlag({
          rules: [
            {
              priority: 1,
              conditions: [{ attribute: "country", operator: "equals", value: "US" }],
              serveVariation: "on",
            },
          ],
        }),
      );
      for (const country of ["US", "CA"]) {
        const fromNode = yield* Flagship.evaluate(app, {
          flagKey: "n",
          defaultValue: false,
          expectedType: "boolean",
          context: { country },
        }).pipe(Effect.orDie);
        const fromBinding = yield* evaluate(worker, {
          method: "getBooleanDetails",
          key: "n",
          defaultValue: false,
          context: { country },
        });
        expect(fromNode).toEqual(fromBinding);
      }
      expect(
        yield* Flagship.evaluate(app, {
          flagKey: "missing",
          defaultValue: 1,
          expectedType: "number",
          context: undefined,
        }).pipe(Effect.orDie),
      ).toMatchObject({ value: 1, errorCode: "FLAG_NOT_FOUND" });

      // Deleting the app removes every flag.
      yield* Flagship.deleteApp(app).pipe(Effect.orDie);
      expect(
        yield* evaluate(worker, { method: "getBooleanDetails", key: "n", defaultValue: false }),
      ).toMatchObject({ errorCode: "FLAG_NOT_FOUND" });
    }).pipe(Effect.scoped),
  );
});
