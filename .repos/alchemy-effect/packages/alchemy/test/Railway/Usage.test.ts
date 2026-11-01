import { Query } from "@distilled.cloud/core/query";
import {
  Railway as RailwayApi,
  type UsageLimitSetInput,
} from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const SOFT_V1 = 100_000;
const SOFT_V2 = 100_001;

const readCustomerId = Query.fn((workspaceId: string) => {
  const workspace = RailwayApi.workspace({ workspaceId });
  return { customer: { id: workspace.customer.id } };
});

const readUsageLimit = Query.fn((workspaceId: string) => {
  const customer = RailwayApi.workspace({ workspaceId }).customer;
  return {
    customer: {
      id: customer.id,
      usageLimit: customer.usageLimit.pipe(
        Query.map((limit) => ({ id: limit.id, softLimit: limit.softLimit })),
      ),
    },
  };
});

const setUsageLimit = Query.fn((input: UsageLimitSetInput) =>
  RailwayApi.usageLimitSet({ input }),
);

const removeUsageLimit = Query.fn((customerId: string) =>
  RailwayApi.usageLimitRemove({ input: { customerId } }),
);

const waitUntilLimitGone = (workspaceId: string, usageLimitId: string) =>
  readUsageLimit(workspaceId).pipe(
    Effect.map((workspace) => {
      const limit = workspace.customer.usageLimit;
      if (limit == null) return "gone" as const;
      return limit.id === usageLimitId ? ("found" as const) : ("gone" as const);
    }),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "usage() returns rows for the current workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rows = yield* Railway.usage({
        measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"],
      });
      expect(Array.isArray(rows)).toEqual(true);
      for (const row of rows) {
        expect(row.measurement).toEqual(expect.any(String));
        expect(row.value).toEqual(expect.any(Number));
      }

      const estimated = yield* Railway.estimatedUsage({
        measurements: ["CPU_USAGE"],
      });
      expect(Array.isArray(estimated)).toEqual(true);
      for (const row of estimated) {
        expect(row.measurement).toEqual(expect.any(String));
        expect(row.estimatedValue).toEqual(expect.any(Number));
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:railway", "provider:railway:usage", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "create, update, list, and delete a usage limit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const workspace = yield* Railway.currentWorkspace();
      const live = yield* readCustomerId(workspace.id);
      const customerId = live.customer.id;
      expect(customerId.length).toBeGreaterThan(0);

      const probe = yield* Effect.result(
        setUsageLimit({
          customerId,
          softLimitDollars: SOFT_V1,
        }),
      );
      if (Result.isFailure(probe)) {
        expect(
          ["RailwayForbidden", "RailwayPlanLimitExceeded"].includes(
            probe.failure._tag,
          ),
        ).toEqual(true);
        yield* stack.destroy();
        return;
      }

      // `usageLimitRemove` is idempotent; it declares no not-found error.
      yield* removeUsageLimit(customerId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.UsageLimit("SpendCap", {
            workspace: { workspaceId: workspace.id },
            limit: SOFT_V1,
          });
        }),
      );

      expect(created.usageLimitId).toEqual(expect.any(String));
      expect(created.usageLimitId.length).toBeGreaterThan(0);
      expect(created.customerId).toEqual(customerId);
      expect(created.workspaceId).toEqual(workspace.id);
      expect(created.softLimitDollars).toEqual(SOFT_V1);
      expect(created.isOverLimit).toEqual(expect.any(Boolean));

      const fetched = yield* readUsageLimit(created.workspaceId);
      expect(fetched.customer.id).toEqual(created.customerId);
      expect(fetched.customer.usageLimit?.id).toEqual(created.usageLimitId);
      expect(fetched.customer.usageLimit?.softLimit).toEqual(SOFT_V1);

      const provider = yield* Provider.findProvider(Railway.UsageLimit);
      const listed = yield* provider.list();
      const found = listed.find(
        (row) => row.usageLimitId === created.usageLimitId,
      );
      expect(found).toBeDefined();
      expect(found?.customerId).toEqual(created.customerId);
      expect(found?.softLimitDollars).toEqual(SOFT_V1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.UsageLimit("SpendCap", {
            workspace: { workspaceId: workspace.id },
            limit: SOFT_V2,
          });
        }),
      );

      expect(updated.customerId).toEqual(created.customerId);
      expect(updated.workspaceId).toEqual(created.workspaceId);
      expect(updated.softLimitDollars).toEqual(SOFT_V2);

      const fetchedUpdate = yield* readUsageLimit(updated.workspaceId);
      expect(fetchedUpdate.customer.usageLimit?.softLimit).toEqual(SOFT_V2);

      yield* stack.destroy();

      const gone = yield* waitUntilLimitGone(
        created.workspaceId,
        created.usageLimitId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:railway", "provider:railway:usage", "live"],
    timeout: 120_000,
  },
);
