import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as orgpolicy from "@distilled.cloud/gcp/orgpolicy_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Project org policies need orgpolicy.policies.create, which only an org-level
// Organization Policy Administrator grant provides; the testing credentials get
// Forbidden "Permission 'orgpolicy.policies.create' denied on resource ...".
// Set GOOGLE_ORGANIZATION_ID when the credentials administer the org.
const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

const CONSTRAINT_A = "compute.disableSerialPortAccess";
const CONSTRAINT_B = "compute.disableSerialPortLogging";

const waitUntilGone = (name: string) =>
  orgpolicy.getProjectsPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        orgpolicy.getProjectsPolicies({
          name: `projects/${project}/policies/compute.alchemyTestDoesNotExist`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* orgpolicy.listProjectsPolicies({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect((page.policies ?? []).map((policy) => policy.name)).not.toContain(
        `projects/${project}/policies/compute.alchemyTestDoesNotExist`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsPolicies without orgpolicy.policies.create fails with Forbidden",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        orgpolicy.createProjectsPolicies({
          parent: `projects/${project}`,
          body: {
            name: `projects/${project}/policies/${CONSTRAINT_A}`,
            spec: { rules: [{ enforce: false }] },
          },
        }),
      );
      expect(error._tag).toBe("Forbidden");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"] },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete a project org policy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.Policy("SerialPort", {
            constraint: CONSTRAINT_A,
            spec: {
              rules: [{ enforce: false }],
            },
          });
        }),
      );

      expect(created.constraint).toEqual(CONSTRAINT_A);
      expect(created.parent).toMatch(/^projects\//);
      expect(created.name).toContain(`/policies/${CONSTRAINT_A}`);
      expect(created.project).toEqual(project);
      expect(created.spec?.rules?.[0]?.enforce).toEqual(false);

      const fetched = yield* orgpolicy.getProjectsPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.spec?.rules?.[0]?.enforce).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.Policy("SerialPort", {
            constraint: CONSTRAINT_A,
            spec: {
              rules: [{ enforce: true }],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.constraint).toEqual(CONSTRAINT_A);
      expect(updated.spec?.rules?.[0]?.enforce).toEqual(true);

      const fetchedUpdate = yield* orgpolicy.getProjectsPolicies({
        name: updated.name,
      });
      expect(fetchedUpdate.spec?.rules?.[0]?.enforce).toEqual(true);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OrgPolicy.Policy("SerialPort", {
            constraint: CONSTRAINT_B,
            spec: {
              rules: [{ enforce: true }],
            },
          });
        }),
      );

      expect(replaced.constraint).toEqual(CONSTRAINT_B);
      expect(replaced.name).toContain(`/policies/${CONSTRAINT_B}`);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.spec?.rules?.[0]?.enforce).toEqual(true);

      const fetchedReplace = yield* orgpolicy.getProjectsPolicies({
        name: replaced.name,
      });
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.spec?.rules?.[0]?.enforce).toEqual(true);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:orgpolicy", "live"], timeout: 90_000 },
);
