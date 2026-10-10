import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, projectContext, runLifecycle, runProbe } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  acm.getAccessPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getAccessPolicies on an inaccessible policy fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        acm.getAccessPolicies({ name: "accessPolicies/123456789012" }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runProbe)(
  "createAccessPolicies without org permissions fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const error = yield* Effect.flip(
        acm.createAccessPolicies({
          body: {
            title: "alchemy-acm-probe",
            parent: ctx.organization ?? "organizations/123456789012",
            scopes:
              ctx.projectNumber.length > 0
                ? [`projects/${ctx.projectNumber}`]
                : undefined,
          },
        }),
      );
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an access policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const scopes =
        ctx.projectNumber.length > 0
          ? [`projects/${ctx.projectNumber}`]
          : undefined;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AccessContextManager.AccessPolicy("Corp", {
            title: "corp access policy",
            scopes,
          });
        }),
      );

      expect(created.name).toMatch(/^accessPolicies\//);
      expect(created.policyId).toEqual(expect.any(String));
      expect(created.parent).toMatch(/^organizations\//);
      expect(created.title).toEqual("corp access policy");

      const fetched = yield* acm.getAccessPolicies({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.title).toContain("alchemy-id=");
      expect(fetched.title).toContain("corp access policy");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AccessContextManager.AccessPolicy("Corp", {
            title: "corp access policy prod",
            scopes,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.title).toEqual("corp access policy prod");

      const fetchedUpdate = yield* acm.getAccessPolicies({
        name: updated.name,
      });
      expect(fetchedUpdate.title).toContain("corp access policy prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 120_000,
  },
);
