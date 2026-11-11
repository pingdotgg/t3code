import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// New accounts read inconsistently for a few seconds after create.
const getAccount = (name: string) =>
  iam.getProjectsServiceAccounts({ name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const waitUntilGone = (name: string) =>
  iam.getProjectsServiceAccounts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a service account",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        GCP.IAM.ServiceAccount("Worker", {
          displayName: "Alchemy worker",
          description: "test account",
        }),
      );

      expect(created.accountId).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
      expect(created.project).toEqual(project);
      expect(created.email).toEqual(`${created.accountId}@${project}.iam.gserviceaccount.com`);
      expect(created.name).toEqual(`projects/${project}/serviceAccounts/${created.email}`);
      expect(created.displayName).toEqual("Alchemy worker");
      expect(created.description).toEqual("test account");
      expect(created.uniqueId).toEqual(expect.any(String));

      const fetched = yield* getAccount(created.name);
      expect(fetched.email).toEqual(created.email);
      expect(fetched.displayName).toEqual("Alchemy worker");
      expect(fetched.description).toMatch(/^\[alchemy .*alchemy-id=\S*worker\]\ntest account$/);

      // Pinning the generated id must update in place, not replace.
      const updated = yield* stack.deploy(
        GCP.IAM.ServiceAccount("Worker", {
          accountId: created.accountId,
          displayName: "Alchemy worker (prod)",
          description: "updated account",
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uniqueId).toEqual(created.uniqueId);
      expect(updated.displayName).toEqual("Alchemy worker (prod)");
      expect(updated.description).toEqual("updated account");

      const fetchedUpdate = yield* getAccount(created.name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (account) => account.displayName === "Alchemy worker (prod)",
          times: 10,
        }),
      );
      expect(fetchedUpdate.displayName).toEqual("Alchemy worker (prod)");
      expect(fetchedUpdate.description).toMatch(/\nupdated account$/);

      yield* stack.destroy();

      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 120_000 },
);
