import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "list workspace audit logs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const types = yield* Railway.listAuditLogEventTypes();
      expect(Array.isArray(types)).toEqual(true);
      for (const item of types) {
        expect(item.eventType).toEqual(expect.any(String));
        expect(item.eventType.length).toBeGreaterThan(0);
        expect(item.description).toEqual(expect.any(String));
      }

      const logs = yield* Railway.listAuditLogs({ first: 10 });
      expect(Array.isArray(logs)).toEqual(true);
      for (const log of logs) {
        expect(log.id).toEqual(expect.any(String));
        expect(log.id.length).toBeGreaterThan(0);
        expect(log.eventType).toEqual(expect.any(String));
        expect(log.eventType.length).toBeGreaterThan(0);
        expect(log.createdAt).toEqual(expect.any(String));
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          return { project, environment };
        }),
      );

      const projectLogs = yield* Railway.listAuditLogs({
        project: created.project,
        environment: created.environment,
        first: 10,
      });
      expect(Array.isArray(projectLogs)).toEqual(true);
      expect(
        projectLogs.every(
          (log) =>
            log.projectId === undefined ||
            log.projectId === created.project.projectId,
        ),
      ).toEqual(true);

      const first = logs[0] ?? projectLogs[0];
      if (first !== undefined) {
        const fetched = yield* Railway.getAuditLog({ id: first.id });
        expect(fetched.id).toEqual(first.id);
        expect(fetched.eventType).toEqual(first.eventType);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
