import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  essentialcontacts.getOrganizationsContacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Organization contacts need org-level Essential Contacts permissions the
// testing service account does not have (calls fail with Forbidden). Set
// GOOGLE_ORGANIZATION_ID on an identity that can manage org contacts.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID;
const runLifecycle = !!organizationId;

const organizationOf = () =>
  Effect.succeed(
    organizationId === undefined
      ? ""
      : organizationId.startsWith("organizations/")
        ? organizationId
        : `organizations/${organizationId}`,
  );

test.provider.skipIf(!runLifecycle)(
  "getOrganizationsContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      const error = yield* Effect.flip(
        essentialcontacts.getOrganizationsContacts({
          name: `${organization}/contacts/0`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:essentialcontacts", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete an organization essential contact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.OrganizationContact("Ops", {
            organization,
            email: "org-ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.organization).toEqual(organization);
      expect(created.email).toEqual("org-ops@example.com");
      expect(created.languageTag).toEqual("en-US");

      const fetched = yield* essentialcontacts.getOrganizationsContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.OrganizationContact("Ops", {
            organization,
            email: "org-ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["LEGAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual(["LEGAL"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.OrganizationContact("Ops", {
            organization,
            email: "org-sec@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("org-sec@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:essentialcontacts", "live"],
    timeout: 90_000,
  },
);
