import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  jobs.getProjectsTenantsCompanies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runLifecycle)(
  "getProjectsTenantsCompanies on a missing company fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.getProjectsTenantsCompanies({
          name: `projects/${project}/tenants/alchemy-missing/companies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsTenantsCompanies fails with TalentDataPermissionRequired until onboarded",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        jobs.createProjectsTenantsCompanies({
          parent: `projects/${project}/tenants/alchemy-missing`,
          body: {
            externalId: "alchemy-company-probe",
            displayName: "Alchemy Probe",
          },
        }),
      );
      expect(error._tag).toEqual("TalentDataPermissionRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a company",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* GCP.Jobs.Tenant("AcmeCo", {
            externalId: "acme-company-tenant",
          });
          const company = yield* GCP.Jobs.TenantsCompany("Labs", {
            parent: tenant.name,
            externalId: "acme-labs",
            displayName: "Acme Labs",
            websiteUri: "https://www.example.com",
          });
          return { tenant, company };
        }),
      );

      expect(created.company.name).toContain("/companies/");
      expect(created.company.parent).toEqual(created.tenant.name);
      expect(created.company.externalId).toEqual("acme-labs");
      expect(created.company.displayName).toEqual("Acme Labs");
      expect(created.company.websiteUri).toEqual("https://www.example.com");

      const fetched = yield* jobs.getProjectsTenantsCompanies({
        name: created.company.name,
      });
      expect(fetched.name).toEqual(created.company.name);
      expect(fetched.displayName).toEqual("Acme Labs");
      expect(fetched.websiteUri).toEqual("https://www.example.com");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* GCP.Jobs.Tenant("AcmeCo", {
            tenantId: created.tenant.tenantId,
            externalId: "acme-company-tenant",
          });
          const company = yield* GCP.Jobs.TenantsCompany("Labs", {
            parent: tenant.name,
            companyId: created.company.companyId,
            externalId: "acme-labs",
            displayName: "Acme Research",
            websiteUri: "https://careers.example.com",
            headquartersAddress: "Mountain View, CA",
          });
          return { tenant, company };
        }),
      );

      expect(updated.company.name).toEqual(created.company.name);
      expect(updated.company.displayName).toEqual("Acme Research");
      expect(updated.company.websiteUri).toEqual("https://careers.example.com");
      expect(updated.company.headquartersAddress).toEqual("Mountain View, CA");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.company.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:jobs", "live"], timeout: 90_000 },
);
