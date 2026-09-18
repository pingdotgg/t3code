import * as AWS from "@/AWS";
import { DBParameterGroup } from "@/AWS/RDS/DBParameterGroup.ts";
import * as Drift from "@/Drift.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

/** The parameters RDS reports as user-set, which is what the resource owns. */
const userParameters = Effect.fn(function* (name: string) {
  const pages = yield* rds.describeDBParameters
    .pages({ DBParameterGroupName: name, Source: "user" })
    .pipe(Stream.runCollect);
  return Object.fromEntries(
    Array.from(pages)
      .flatMap((page) => page.Parameters ?? [])
      .flatMap((p) =>
        p.ParameterName && p.ParameterValue !== undefined
          ? [[p.ParameterName, p.ParameterValue] as const]
          : [],
      ),
  );
});

const groupParameters = Effect.fn(function* (name: string) {
  const pages = yield* rds.describeDBParameters
    .pages({ DBParameterGroupName: name })
    .pipe(Stream.runCollect);
  return new Map(
    Array.from(pages).flatMap((page) =>
      (page.Parameters ?? []).flatMap((parameter) =>
        parameter.ParameterName === undefined
          ? []
          : [[parameter.ParameterName, parameter] as const],
      ),
    ),
  );
});

const waitForParameters = Effect.fn(function* (
  name: string,
  ready: (parameters: Map<string, rds.Parameter>) => boolean,
) {
  const parameters = yield* groupParameters(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      times: 8,
      until: ready,
    }),
  );
  expect(ready(parameters)).toBe(true);
  return parameters;
});

const modifyParameters = (name: string, parameters: rds.Parameter[]) =>
  rds
    .modifyDBParameterGroup({
      DBParameterGroupName: name,
      Parameters: parameters,
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "InvalidDBParameterGroupStateFault",
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
      }),
    );

const resetParameters = (name: string, parameters: rds.Parameter[]) =>
  rds
    .resetDBParameterGroup({
      DBParameterGroupName: name,
      ResetAllParameters: false,
      Parameters: parameters,
    })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "InvalidDBParameterGroupStateFault",
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
      }),
    );

const assertGroupGone = Effect.fn(function* (name: string) {
  const gone = yield* rds
    .describeDBParameterGroups({
      DBParameterGroupName: name,
    })
    .pipe(
      Effect.as(false),
      Effect.catchTag("DBParameterGroupNotFoundFault", () =>
        Effect.succeed(true),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
        until: (gone) => gone,
      }),
    );
  expect(gone).toBe(true);
});

// Canonical `list()` test (AWS account/region-scoped collection). Parameter
// groups create and delete fast (well within the 240s budget), so we deploy a
// real group, resolve the provider via the typed `Provider.findProvider(
// DBParameterGroup)` so `list()`'s element type is the exact
// `DBParameterGroup["Attributes"]` shape, call it, and assert the deployed
// group appears in the exhaustively-paginated result.
test.provider("list enumerates the deployed DB parameter group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* DBParameterGroup("ListDBParameterGroup", {
          dbParameterGroupName: "alchemy-test-dbpg-list",
          family: "aurora-postgresql16",
          description: "Alchemy list() test parameter group",
        });
      }),
    );

    const provider = yield* Provider.findProvider(DBParameterGroup);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    expect(
      all.some((g) => g.dbParameterGroupName === group.dbParameterGroupName),
    ).toBe(true);

    for (const g of all) {
      expect(typeof g.dbParameterGroupName).toBe("string");
      expect(typeof g.family).toBe("string");
    }

    yield* stack.destroy();
  }),
);

// Parameters reconcile in place: a redeploy writes changed values and resets
// keys the props dropped, both diffed against live `Source=user` state rather
// than the prior props.
test.provider("parameters are written, updated and reset", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-dbpg-params";
    const deploy = (parameters: Record<string, string>) =>
      stack.deploy(
        Effect.gen(function* () {
          return yield* DBParameterGroup("ParamsDBParameterGroup", {
            dbParameterGroupName: name,
            family: "mysql8.4",
            description: "Alchemy parameters test parameter group",
            parameters,
          });
        }),
      );

    const created = yield* deploy({
      time_zone: "Australia/Sydney",
      max_connections: "150",
    });
    expect(created.parameters.time_zone).toBe("Australia/Sydney");

    const afterCreate = yield* userParameters(name);
    expect(afterCreate.time_zone).toBe("Australia/Sydney");
    expect(afterCreate.max_connections).toBe("150");

    // time_zone changes; max_connections is dropped and must go back to the
    // engine default, which removes it from Source=user entirely.
    yield* deploy({ time_zone: "UTC" });

    const afterUpdate = yield* userParameters(name);
    expect(afterUpdate.time_zone).toBe("UTC");
    expect(afterUpdate.max_connections).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider(
  "PR1589 adoption resets undeclared overrides to the same defaults as creation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-test-pr1589-adopt-parameters";
      yield* rds.createDBParameterGroup({
        DBParameterGroupName: name,
        DBParameterGroupFamily: "postgres16",
        Description: "Desired-state adoption regression",
      });
      yield* modifyParameters(name, [
        {
          ParameterName: "work_mem",
          ParameterValue: "8192",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) => parameters.get("work_mem")?.ParameterValue === "8192",
      );
      const program = DBParameterGroup("AdoptedParameters1589", {
        dbParameterGroupName: name,
        family: "postgres16",
        description: "Desired-state adoption regression",
      });
      const adopted = yield* stack.deploy(program);
      expect(adopted.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* stack.plan(program)).resources.AdoptedParameters1589?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1589 resets omitted overrides and observes settled modify/reset outputs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        DBParameterGroup("ObservedParameters1589", {
          family: "postgres16",
          parameters,
        });
      const created = yield* stack.deploy(program());
      const name = created.dbParameterGroupName;
      const defaults = yield* groupParameters(name);
      expect(defaults.get("max_connections")?.ApplyType).toBe("static");
      expect(defaults.get("work_mem")?.ApplyType).toBe("dynamic");

      yield* modifyParameters(name, [
        {
          ParameterName: "work_mem",
          ParameterValue: "8192",
          ApplyMethod: "immediate",
        },
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("work_mem")?.ParameterValue === "8192" &&
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      const overrides = { work_mem: "8192", max_connections: "200" };
      expect(yield* userParameters(name)).toEqual(overrides);

      const plan = yield* stack.plan(program());
      expect(plan.resources.ObservedParameters1589?.action).toBe("update");
      const observed = yield* stack.deploy(program());
      expect(observed.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      const settled = yield* stack.plan(program());
      expect(settled.resources.ObservedParameters1589?.action).toBe("noop");
      const refreshed = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(refreshed.resources.ObservedParameters1589).toMatchObject({
        action: "unchanged",
        attr: { parameters: {} },
      });

      const changed = yield* stack.deploy(
        program({ work_mem: "16384", max_connections: "250" }),
      );
      expect(changed.dbParameterGroupName).toBe(name);
      expect(changed.dbParameterGroupArn).toBe(created.dbParameterGroupArn);
      expect(changed.parameters).toEqual({
        work_mem: "16384",
        max_connections: "250",
      });
      // No test-side wait: reconcile must return observed, settled group values.
      expect(yield* userParameters(name)).toEqual(changed.parameters);
      const resetStatic = yield* stack.deploy(program({ work_mem: "16384" }));
      expect(resetStatic.parameters).toEqual({ work_mem: "16384" });
      expect(yield* userParameters(name)).toEqual(resetStatic.parameters);
      const afterReset = (yield* groupParameters(name)).get("max_connections");
      expect(afterReset?.Source).toBe(defaults.get("max_connections")?.Source);
      expect(afterReset?.ParameterValue).toBe(
        defaults.get("max_connections")?.ParameterValue,
      );

      const cleared = yield* stack.deploy(program());
      expect(cleared.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* groupParameters(name)).get("work_mem")?.ParameterValue,
      ).toBe(defaults.get("work_mem")?.ParameterValue);
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1589 refresh retains managed defaults after an out-of-band reset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        DBParameterGroup("DefaultParameters1589", {
          family: "postgres16",
          parameters,
        });
      const created = yield* stack.deploy(program());
      const name = created.dbParameterGroupName;
      const defaults = yield* groupParameters(name);
      const parameter = defaults.get("log_autovacuum_min_duration");
      expect(parameter?.Source).toBe("engine-default");
      expect(parameter?.ApplyType).toBe("dynamic");
      expect(parameter?.IsModifiable).toBe(true);
      if (parameter?.ParameterValue === undefined) {
        return yield* Effect.fail(
          new Error(
            "RDS did not report the log_autovacuum_min_duration default",
          ),
        );
      }
      const desired = { log_autovacuum_min_duration: parameter.ParameterValue };
      const managed = yield* stack.deploy(program(desired));
      expect(managed.parameters).toEqual(desired);
      expect(
        (yield* groupParameters(name)).get("log_autovacuum_min_duration")
          ?.Source,
      ).toBe("engine-default");
      const initial = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(initial.resources.DefaultParameters1589).toMatchObject({
        action: "unchanged",
        attr: { parameters: desired },
      });

      const driftedValue =
        parameter.ParameterValue === "8192" ? "16384" : "8192";
      yield* modifyParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ParameterValue: driftedValue,
          ApplyMethod: "immediate",
        },
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            driftedValue &&
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(drift.resources.DefaultParameters1589?.attr.parameters).toEqual({
        log_autovacuum_min_duration: driftedValue,
        max_connections: "200",
      });

      yield* resetParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.Source ===
            "engine-default" &&
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            desired.log_autovacuum_min_duration,
      );
      const reset = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(reset.resources.DefaultParameters1589?.attr.parameters).toEqual({
        ...desired,
        max_connections: "200",
      });
      expect(yield* userParameters(name)).toEqual({ max_connections: "200" });
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1590 adoption resets undeclared overrides to the same defaults as creation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-test-pr1590-adopt-parameters";
      yield* rds.createDBParameterGroup({
        DBParameterGroupName: name,
        DBParameterGroupFamily: "postgres16",
        Description: "Desired-state adoption regression",
      });
      yield* modifyParameters(name, [
        {
          ParameterName: "work_mem",
          ParameterValue: "8192",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) => parameters.get("work_mem")?.ParameterValue === "8192",
      );
      const program = DBParameterGroup("AdoptedParameters1590", {
        dbParameterGroupName: name,
        family: "postgres16",
        description: "Desired-state adoption regression",
      });
      const adopted = yield* stack.deploy(program);
      expect(adopted.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* stack.plan(program)).resources.AdoptedParameters1590?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1590 plans and repairs live modify/reset drift with unchanged props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        Effect.gen(function* () {
          const group = yield* DBParameterGroup("DriftParameters1590", {
            family: "postgres16",
            parameters,
          });
          const dependent = yield* DBParameterGroup("StableReference1590", {
            family: "postgres16",
            tags: {
              groupName: group.dbParameterGroupName,
              groupArn: group.dbParameterGroupArn.as<string>(),
            },
          });
          return { group, dependent };
        });
      const initial = yield* stack.deploy(program({}));
      const name = initial.group.dbParameterGroupName;
      const defaults = yield* groupParameters(name);
      const parameter = defaults.get("log_autovacuum_min_duration");
      expect(parameter?.Source).toBe("engine-default");
      expect(parameter?.ApplyType).toBe("dynamic");
      expect(parameter?.IsModifiable).toBe(true);
      const defaultValue = parameter?.ParameterValue;
      expect(defaultValue).toBeDefined();
      const desired = {
        log_autovacuum_min_duration: defaultValue === "8192" ? "16384" : "8192",
      };
      const created = yield* stack.deploy(program(desired));
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
          desired.log_autovacuum_min_duration,
      );
      const clean = yield* stack.plan(program(desired));
      expect(clean.resources.DriftParameters1590?.action).toBe("noop");
      expect(clean.resources.StableReference1590?.action).toBe("noop");

      const driftedValue =
        desired.log_autovacuum_min_duration === "8192" ? "16384" : "8192";
      yield* modifyParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ParameterValue: driftedValue,
          ApplyMethod: "immediate",
        },
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            driftedValue &&
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      // No refresh before planning: persisted props and outputs still match.
      const drift = yield* stack.plan(program(desired));
      expect(drift.resources.DriftParameters1590?.action).toBe("update");
      expect(drift.resources.StableReference1590?.action).toBe("noop");
      expect(yield* userParameters(name)).toEqual({
        log_autovacuum_min_duration: driftedValue,
        max_connections: "200",
      });

      const repaired = yield* stack.deploy(program(desired));
      expect(repaired.group.dbParameterGroupName).toBe(name);
      expect(repaired.group.dbParameterGroupArn).toBe(
        created.group.dbParameterGroupArn,
      );
      expect(repaired.group.parameters).toEqual(desired);
      expect(yield* userParameters(name)).toEqual(desired);
      expect(
        (yield* stack.plan(program(desired))).resources.DriftParameters1590
          ?.action,
      ).toBe("noop");

      yield* resetParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.Source ===
            "engine-default" &&
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            defaultValue,
      );
      const resetDrift = yield* stack.plan(program(desired));
      expect(resetDrift.resources.DriftParameters1590?.action).toBe("update");
      expect(resetDrift.resources.StableReference1590?.action).toBe("noop");
      expect(yield* userParameters(name)).toEqual({});
      yield* stack.deploy(program(desired));
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
          desired.log_autovacuum_min_duration,
      );
      expect(yield* userParameters(name)).toEqual(desired);

      const omitted = yield* stack.deploy(program());
      expect(omitted.group.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      yield* modifyParameters(name, [
        {
          ParameterName: "max_connections",
          ParameterValue: "200",
          ApplyMethod: "pending-reboot",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("max_connections")?.ParameterValue === "200",
      );
      const omittedDrift = yield* stack.plan(program());
      expect(omittedDrift.resources.DriftParameters1590?.action).toBe("update");
      expect(omittedDrift.resources.StableReference1590?.action).toBe("noop");
      const cleared = yield* stack.deploy(program());
      expect(cleared.group.parameters).toEqual({});
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* stack.plan(program())).resources.DriftParameters1590?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertGroupGone(name);
      yield* assertGroupGone(created.dependent.dbParameterGroupName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1590 treats a reset to an explicitly managed default as no drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (parameters?: Record<string, string>) =>
        DBParameterGroup("DefaultParameters1590", {
          family: "postgres16",
          parameters,
        });
      const created = yield* stack.deploy(program());
      const name = created.dbParameterGroupName;
      const parameter = (yield* groupParameters(name)).get(
        "log_autovacuum_min_duration",
      );
      expect(parameter?.Source).toBe("engine-default");
      expect(parameter?.ApplyType).toBe("dynamic");
      expect(parameter?.IsModifiable).toBe(true);
      if (parameter?.ParameterValue === undefined) {
        return yield* Effect.fail(
          new Error(
            "RDS did not report the log_autovacuum_min_duration default",
          ),
        );
      }
      const desired = { log_autovacuum_min_duration: parameter.ParameterValue };
      yield* stack.deploy(program(desired));
      expect(
        (yield* groupParameters(name)).get("log_autovacuum_min_duration")
          ?.Source,
      ).toBe("engine-default");
      expect(
        (yield* stack.plan(program(desired))).resources.DefaultParameters1590
          ?.action,
      ).toBe("noop");
      const initial = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(initial.resources.DefaultParameters1590).toMatchObject({
        action: "unchanged",
        attr: { parameters: desired },
      });

      const driftedValue =
        desired.log_autovacuum_min_duration === "8192" ? "16384" : "8192";
      yield* modifyParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ParameterValue: driftedValue,
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
          driftedValue,
      );
      const drift = yield* stack.plan(program(desired));
      expect(drift.resources.DefaultParameters1590?.action).toBe("update");
      yield* stack.deploy(program(desired));
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
          desired.log_autovacuum_min_duration,
      );
      // Writing the default value need not remove Source=user; reset does.
      yield* resetParameters(name, [
        {
          ParameterName: "log_autovacuum_min_duration",
          ApplyMethod: "immediate",
        },
      ]);
      yield* waitForParameters(
        name,
        (parameters) =>
          parameters.get("log_autovacuum_min_duration")?.Source ===
            "engine-default" &&
          parameters.get("log_autovacuum_min_duration")?.ParameterValue ===
            desired.log_autovacuum_min_duration,
      );
      expect(yield* userParameters(name)).toEqual({});
      expect(
        (yield* stack.plan(program(desired))).resources.DefaultParameters1590
          ?.action,
      ).toBe("noop");
      const reset = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      }).pipe(Effect.provide(stack.state));
      expect(reset.resources.DefaultParameters1590).toMatchObject({
        action: "unchanged",
        attr: { parameters: desired },
      });
      yield* stack.destroy();
      yield* assertGroupGone(name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "PR1590 clears stable references and recreates an out-of-band deleted group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const group = yield* DBParameterGroup("MissingParameters1590", {
          family: "postgres16",
          parameters: {},
        });
        const dependent = yield* DBParameterGroup("MissingReference1590", {
          family: "postgres16",
          tags: {
            groupName: group.dbParameterGroupName,
            groupArn: group.dbParameterGroupArn.as<string>(),
          },
        });
        return { group, dependent };
      });
      const created = yield* stack.deploy(program);
      const name = created.group.dbParameterGroupName;
      const clean = yield* stack.plan(program);
      expect(clean.resources.MissingParameters1590?.action).toBe("noop");
      expect(clean.resources.MissingReference1590?.action).toBe("noop");

      // Intentional drift, not cleanup: the engine must discover and recreate it.
      yield* rds.deleteDBParameterGroup({ DBParameterGroupName: name }).pipe(
        Effect.retry({
          while: (error) => error._tag === "InvalidDBParameterGroupStateFault",
          schedule: Schedule.spaced("3 seconds"),
          times: 8,
        }),
      );
      yield* assertGroupGone(name);
      const missing = yield* stack.plan(program);
      expect(missing.resources.MissingParameters1590?.action).toBe("update");
      expect(missing.resources.MissingReference1590?.action).toBe("update");
      yield* assertGroupGone(name);

      const recreated = yield* stack.deploy(program);
      expect(recreated.group.dbParameterGroupName).toBe(name);
      expect(recreated.group.dbParameterGroupArn).toBe(
        created.group.dbParameterGroupArn,
      );
      expect(recreated.dependent.dbParameterGroupName).toBe(
        created.dependent.dbParameterGroupName,
      );
      const live = yield* rds.describeDBParameterGroups({
        DBParameterGroupName: name,
      });
      expect(live.DBParameterGroups?.[0]?.DBParameterGroupArn).toBe(
        created.group.dbParameterGroupArn,
      );
      expect(
        (yield* stack.plan(program)).resources.MissingReference1590?.action,
      ).toBe("noop");
      yield* stack.destroy();
      yield* assertGroupGone(name);
      yield* assertGroupGone(created.dependent.dbParameterGroupName);
    }),
  { timeout: 120_000 },
);
