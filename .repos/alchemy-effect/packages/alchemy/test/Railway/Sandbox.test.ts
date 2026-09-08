import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
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

const isGoneStatus = (status: string | undefined) =>
  status === "DESTROYED" || status === "DESTROYING";

const waitUntilGone = (environmentId: string, sandboxId: string) =>
  railway.sandbox({ environmentId, id: sandboxId }).pipe(
    Effect.map((sandbox) =>
      isGoneStatus(sandbox.status) ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const destroyLive = (environmentId: string, sandboxId: string) =>
  railway.sandboxDestroy({ environmentId, id: sandboxId }).pipe(
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
    Effect.flatMap(() => waitUntilGone(environmentId, sandboxId)),
  );

test.provider(
  "sandbox create surfaces a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          return { project, environment };
        }),
      );

      const result = yield* Effect.result(
        railway.sandboxCreate({
          input: {
            environmentId: created.environment.environmentId,
            idleTimeoutMinutes: 5,
          },
        }),
      );

      if (Result.isSuccess(result)) {
        yield* Effect.logInfo(
          "sandboxes are entitled on this token; probe is a no-op",
        );
        yield* destroyLive(result.success.environmentId, result.success.id);
        yield* stack.destroy();
        return;
      }

      expect(result.failure._tag).toEqual("RailwayForbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider(
  "create, exec, and destroy a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const box = yield* Railway.Sandbox("Box", {
            environment,
            idleTimeoutMinutes: 5,
          });
          return { project, environment, box };
        }),
      );

      expect(created.box.sandboxId).toEqual(expect.any(String));
      expect(created.box.sandboxId.length).toBeGreaterThan(0);
      expect(created.box.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.box.projectId).toEqual(created.project.projectId);
      expect(created.box.status).toEqual("RUNNING");
      expect(created.box.region).toEqual(expect.any(String));
      expect(created.box.region.length).toBeGreaterThan(0);
      expect(created.box.createdAt).toEqual(expect.any(String));
      expect(created.box.idleTimeoutMinutes).toEqual(5);

      const fetched = yield* railway.sandbox({
        environmentId: created.box.environmentId,
        id: created.box.sandboxId,
      });
      expect(fetched.id).toEqual(created.box.sandboxId);
      expect(fetched.environmentId).toEqual(created.box.environmentId);
      expect(fetched.status).toEqual("RUNNING");
      expect(fetched.idleTimeoutMinutes).toEqual(5);

      const executed = yield* Railway.execSandbox({
        sandboxId: created.box.sandboxId,
        environmentId: created.box.environmentId,
        command: "echo hello",
        timeoutSec: 30,
      });
      expect(executed.exitCode).toEqual(0);
      expect(executed.timedOut).toEqual(false);
      expect(executed.stdout).toContain("hello");

      const provider = yield* Provider.findProvider(Railway.Sandbox);
      const listed = yield* provider.list();
      const found = listed.find(
        (sandbox) => sandbox.sandboxId === created.box.sandboxId,
      );
      expect(found).toBeDefined();
      expect(found?.environmentId).toEqual(created.box.environmentId);
      expect(found?.status).toEqual("RUNNING");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.box.environmentId,
        created.box.sandboxId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
