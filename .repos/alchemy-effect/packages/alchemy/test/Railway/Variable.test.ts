import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const VALUE_A = Redacted.make("alchemy-railway-var-a");
const VALUE_B = Redacted.make("alchemy-railway-var-b");

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const readVariables = (
  projectId: string,
  environmentId: string,
  serviceId?: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      ...(serviceId !== undefined ? { serviceId } : {}),
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const waitUntilVariableGone = (
  projectId: string,
  environmentId: string,
  name: string,
) =>
  readVariables(projectId, environmentId).pipe(
    Effect.map((vars) =>
      Object.hasOwn(vars, name) ? ("found" as const) : ("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const matchesPlain = (observed: string | undefined, expected: string) =>
  observed === expected;

test.provider(
  "create, update, list, and delete a variable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const variable = yield* Railway.Variable("DbUrl", {
            project,
            environment,
            value: VALUE_A,
          });
          return { project, environment, variable };
        }),
      );

      expect(created.variable.projectId).toEqual(created.project.projectId);
      expect(created.variable.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.variable.serviceId).toBeUndefined();
      expect(created.variable.name).toEqual(expect.any(String));
      expect(created.variable.name.length).toBeGreaterThan(0);
      expect(created.variable.digest).toEqual(expect.any(String));
      expect(created.variable.digest.length).toBeGreaterThan(0);
      expect(Object.hasOwn(created.variable, "value")).toBe(false);

      const fetched = yield* readVariables(
        created.variable.projectId,
        created.variable.environmentId,
      );
      expect(Object.hasOwn(fetched, created.variable.name)).toBe(true);
      expect(
        matchesPlain(fetched[created.variable.name], Redacted.value(VALUE_A)),
      ).toBe(true);

      const provider = yield* Provider.findProvider(Railway.Variable);
      const listed = yield* provider.list();
      const found = listed.find(
        (variable) =>
          variable.projectId === created.variable.projectId &&
          variable.environmentId === created.variable.environmentId &&
          variable.name === created.variable.name,
      );
      expect(found).toBeDefined();
      expect(found?.digest).toEqual(created.variable.digest);
      expect(found !== undefined && Object.hasOwn(found, "value")).toBe(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const variable = yield* Railway.Variable("DbUrl", {
            project,
            environment,
            value: VALUE_B,
          });
          return { project, environment, variable };
        }),
      );

      expect(updated.variable.projectId).toEqual(created.variable.projectId);
      expect(updated.variable.environmentId).toEqual(
        created.variable.environmentId,
      );
      expect(updated.variable.name).toEqual(created.variable.name);
      expect(updated.variable.digest).toEqual(expect.any(String));
      expect(updated.variable.digest).not.toEqual(created.variable.digest);
      expect(Object.hasOwn(updated.variable, "value")).toBe(false);

      const refetched = yield* readVariables(
        updated.variable.projectId,
        updated.variable.environmentId,
      );
      expect(Object.hasOwn(refetched, updated.variable.name)).toBe(true);
      expect(
        matchesPlain(refetched[updated.variable.name], Redacted.value(VALUE_B)),
      ).toBe(true);
      expect(
        matchesPlain(refetched[updated.variable.name], Redacted.value(VALUE_A)),
      ).toBe(false);

      yield* stack.destroy();

      const variableGone = yield* waitUntilVariableGone(
        created.variable.projectId,
        created.variable.environmentId,
        created.variable.name,
      );
      expect(variableGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
