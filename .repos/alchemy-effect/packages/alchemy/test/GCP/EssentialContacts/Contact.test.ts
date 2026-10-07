import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
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

const waitUntilGone = (name: string) =>
  essentialcontacts.getProjectsContacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        essentialcontacts.getProjectsContacts({
          name: `projects/${project}/contacts/0`,
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

test.provider(
  "create, update, replace, and delete a project essential contact",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.Contact("Ops", {
            email: "ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.name).toContain("/contacts/");
      expect(created.email).toEqual("ops@example.com");
      expect(created.languageTag).toEqual("en-US");
      expect(created.notificationCategorySubscriptions).toEqual(["ALL"]);
      expect(created.project).toEqual(project);

      const fetched = yield* essentialcontacts.getProjectsContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");
      expect(fetched.email).toContain("ops@");
      expect(fetched.languageTag).toEqual("en-US");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.Contact("Ops", {
            email: "ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY", "TECHNICAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.email).toEqual("ops@example.com");
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual([
        "SECURITY",
        "TECHNICAL",
      ]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.Contact("Ops", {
            email: "security@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("security@example.com");
      expect(replaced.contactId.length).toBeGreaterThan(0);
      expect(replaced.languageTag).toEqual("en-GB");
      expect(replaced.notificationCategorySubscriptions).toEqual(["SECURITY"]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:essentialcontacts", "live"],
    timeout: 90_000,
  },
);
