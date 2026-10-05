import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamanager from "@distilled.cloud/gcp/datamanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { PROBE_NAME, PROBE_PARENT } from "@/GCP/DataManager/internal.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  datamanager.getAccountTypesAccountsUserLists({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The lifecycle needs a Google Ads / DV360 / data-partner account the
// credentials can write, e.g. `accountTypes/GOOGLE_ADS/accounts/123`.
const lifecycleParent = process.env.GCP_TEST_DATAMANAGER_PARENT?.trim();

const probeCreate = (parent: string) =>
  datamanager.createAccountTypesAccountsUserLists({
    parent,
    body: {
      displayName: "Alchemy Datamanager Probe",
      ingestedUserListInfo: { uploadKeyTypes: ["CONTACT_ID"] },
    },
  });

test.provider(
  "getAccountTypesAccountsUserLists on a missing user list fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamanager.getAccountTypesAccountsUserLists({ name: PROBE_NAME }),
      );
      expect(error._tag).toEqual("DataManagerScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createAccountTypesAccountsUserLists without Data Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(probeCreate(PROBE_PARENT));
      expect(error._tag).toEqual("DataManagerScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST || !lifecycleParent)(
  "create, update, and delete a user list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = lifecycleParent!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataManager.AccountTypesUserList("Customers", {
            parent,
            displayName: "checkout-buyers",
            membershipStatus: "OPEN",
            membershipDuration: "2592000s",
            ingestedUserListInfo: { uploadKeyTypes: ["CONTACT_ID"] },
          });
        }),
      );

      expect(created.name).toContain("/userLists/");
      expect(created.parent).toEqual(parent);
      expect(created.userListId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("checkout-buyers");
      expect(created.membershipStatus).toEqual("OPEN");
      expect(created.ingestedUserListInfo?.uploadKeyTypes).toContain(
        "CONTACT_ID",
      );

      const fetched = yield* datamanager.getAccountTypesAccountsUserLists({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("checkout-buyers");
      expect(fetched.membershipStatus).toEqual("OPEN");

      const listed = yield* datamanager.listAccountTypesAccountsUserLists({
        parent,
        pageSize: 200,
      });
      expect(
        (listed.userLists ?? []).some((row) => row.name === created.name),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataManager.AccountTypesUserList("Customers", {
            parent: created.parent,
            displayName: "checkout-buyers-v2",
            membershipStatus: "CLOSED",
            membershipDuration: "2592000s",
            ingestedUserListInfo: { uploadKeyTypes: ["CONTACT_ID"] },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("checkout-buyers-v2");
      expect(updated.membershipStatus).toEqual("CLOSED");

      const fetchedUpdate = yield* datamanager.getAccountTypesAccountsUserLists(
        { name: updated.name },
      );
      expect(fetchedUpdate.displayName).toEqual("checkout-buyers-v2");
      expect(fetchedUpdate.membershipStatus).toEqual("CLOSED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamanager", "live"],
    timeout: 90_000,
  },
);
