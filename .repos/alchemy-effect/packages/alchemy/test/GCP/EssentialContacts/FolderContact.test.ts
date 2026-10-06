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
  essentialcontacts.getFoldersContacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Folder contacts need a folder the test identity can manage contacts on.
// Set GOOGLE_FOLDER_ID to run these tests.
const folderId = process.env.GOOGLE_FOLDER_ID;
const runLifecycle = !!folderId;

const folderOf = () =>
  Effect.succeed(
    folderId === undefined
      ? ""
      : folderId.startsWith("folders/")
        ? folderId
        : `folders/${folderId}`,
  );

test.provider.skipIf(!runLifecycle)(
  "getFoldersContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      const error = yield* Effect.flip(
        essentialcontacts.getFoldersContacts({
          name: `${folder}/contacts/0`,
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
  "create, update, replace, and delete a folder essential contact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.parent).toEqual(folder);
      expect(created.email).toEqual("folder-ops@example.com");
      expect(created.languageTag).toEqual("en-US");

      const fetched = yield* essentialcontacts.getFoldersContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["TECHNICAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual(["TECHNICAL"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.EssentialContacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-sec@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("folder-sec@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:essentialcontacts", "live"],
    timeout: 90_000,
  },
);
