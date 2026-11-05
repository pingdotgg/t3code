import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as sts from "@distilled.cloud/aws/sts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, repairDrift, waitForDrift } from "../drift.ts";

const asyncServerMain = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:lambda", "live"];

interface Statement {
  Sid: string;
  Effect: string;
  Principal: { AWS?: string; Service?: string };
  Resource: string;
}

const statementsOf = (functionArn: string) =>
  LambdaWeb.getResourcePolicy({ resourceArn: functionArn }).pipe(
    Effect.map((r) => (JSON.parse(r.policy) as { Statement: Statement[] }).Statement),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([] as Statement[])),
  );

test.provider(
  "grants coexist in one policy; removing one keeps the other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Account: accountId } = yield* sts.getCallerIdentity({});

      const deploy = (grants: ("Partner" | "Auditor")[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.Lambda.WebFunction("Granted", {
              main: asyncServerMain,
              authType: "IamAuth",
            });
            const permissions: Partial<
              Record<"Partner" | "Auditor", AWS.Lambda.WebFunctionPermission>
            > = {};
            for (const grant of grants) {
              permissions[grant] = yield* AWS.Lambda.WebFunctionPermission(grant, {
                endpoint: api,
                principal: accountId!,
              });
            }
            return { api, permissions };
          }),
        );

      const { api, permissions } = yield* deploy(["Partner", "Auditor"]);
      const statementIds = {
        Partner: permissions.Partner!.statementId,
        Auditor: permissions.Auditor!.statementId,
      };
      const both = yield* statementsOf(api.functionArn);
      expect(both.map((s) => s.Sid).sort()).toEqual(
        [statementIds.Partner!, statementIds.Auditor!].sort(),
      );
      for (const statement of both) {
        expect(statement.Resource).toBe(api.endpointArn);
        expect(statement.Principal.AWS).toContain(accountId!);
      }

      yield* deploy(["Auditor"]);
      const remaining = yield* statementsOf(api.functionArn);
      expect(remaining.map((s) => s.Sid)).toEqual([statementIds.Auditor!]);

      yield* deploy([]);
      expect(yield* statementsOf(api.functionArn)).toEqual([]);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

test.provider(
  "refuses to grant invoke on a public endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Account: accountId } = yield* sts.getCallerIdentity({});
      const failure = yield* stack
        .deploy(
          Effect.gen(function* () {
            const api = yield* AWS.Lambda.WebFunction("Public", {
              main: asyncServerMain,
              authType: "ApplicationManaged",
            });
            return yield* AWS.Lambda.WebFunctionPermission("Grant", {
              endpoint: api,
              principal: accountId!,
            });
          }),
        )
        .pipe(Effect.exit);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") {
        expect(String(Cause.squash(failure.cause))).toContain("public");
      }
      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 180_000 },
);

// #2688: the web function, its endpoints and its grants must observe the
// endpoint limits, tags and the full grant statement, or out-of-band changes
// read as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band endpoint limits and grant changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { Account: accountId } = yield* sts.getCallerIdentity({});

      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.Lambda.WebFunction("DriftWeb", {
            main: asyncServerMain,
            authType: "IamAuth",
            rateLimit: 100,
            tags: { team: "declared" },
          });
          yield* AWS.Lambda.WebFunctionEndpoint("DriftDoor", {
            function: api,
            authType: "IamAuth",
            rateLimit: 200,
          });
          yield* AWS.Lambda.WebFunctionPermission("DriftGrant", {
            endpoint: api,
            principal: accountId!,
          });
          return { api };
        }),
      );
      const allUnchanged = (actions: Record<string, string | undefined>) =>
        Object.values(actions).every((action) => action === "unchanged");
      expect(allUnchanged(yield* driftActions(stack))).toBe(true);

      const settle = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.retry({
            while: (e) => e._tag === "ConflictException",
            schedule: Schedule.spaced("2 seconds"),
            times: 15,
          }),
        );
      yield* settle(
        LambdaWeb.updateWebFunctionEndpoint({
          functionName: api.functionName,
          endpointName: api.endpointName,
          throttleConfig: { rateLimit: 300 },
        }),
      );
      yield* settle(
        LambdaWeb.updateWebFunctionEndpoint({
          functionName: api.functionName,
          endpointName: "DriftDoor",
          throttleConfig: { rateLimit: 400 },
        }),
      );
      const policy = yield* LambdaWeb.getResourcePolicy({ resourceArn: api.functionArn });
      const document = JSON.parse(policy.policy) as { Statement: Record<string, unknown>[] };
      yield* LambdaWeb.putResourcePolicy({
        resourceArn: api.functionArn,
        revisionId: policy.revisionId,
        policy: JSON.stringify({
          ...document,
          Statement: document.Statement.map((statement) => ({ ...statement, Effect: "Deny" })),
        }),
      });

      expect((yield* waitForDrift(stack, "DriftWeb", "drifted"))?.attr?.rateLimit).toBe(300);
      expect((yield* waitForDrift(stack, "DriftDoor", "drifted"))?.attr?.rateLimit).toBe(400);
      expect((yield* waitForDrift(stack, "DriftGrant", "drifted"))?.attr?.statement?.Effect).toBe(
        "Deny",
      );

      yield* repairDrift(stack);
      const after = yield* driftActions(stack).pipe(
        Effect.repeat({
          until: allUnchanged,
          schedule: Schedule.spaced("2 seconds"),
          times: 15,
        }),
      );
      expect(after).toEqual({
        DriftWeb: "unchanged",
        DriftDoor: "unchanged",
        DriftGrant: "unchanged",
      });
      const restored = yield* LambdaWeb.getWebFunctionEndpoint({
        functionName: api.functionName,
        endpointName: api.endpointName,
      });
      expect(restored.throttleConfig?.rateLimit).toBe(100);
      const statements = yield* statementsOf(api.functionArn);
      expect(statements.map((s) => s.Effect)).toEqual(["Allow"]);

      // A deleted built-in endpoint must read as drift, not as the last
      // persisted address.
      yield* settle(
        LambdaWeb.deleteWebFunctionEndpoint({
          functionName: api.functionName,
          endpointName: api.endpointName,
        }),
      );
      const gone = yield* waitForDrift(stack, "DriftWeb", "drifted");
      expect(gone?.attr?.url).toBe("");
      yield* repairDrift(stack);
      expect((yield* waitForDrift(stack, "DriftWeb", "unchanged"))?.action).toBe("unchanged");
      const recreated = yield* LambdaWeb.getWebFunctionEndpoint({
        functionName: api.functionName,
        endpointName: api.endpointName,
      });
      expect(recreated.throttleConfig?.rateLimit).toBe(100);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 360_000 },
);
