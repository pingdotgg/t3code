import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probeAccountName,
  probeCustomerBody,
  runLifecycle,
  waitUntilCustomerGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getAccountsCustomers on a missing customer fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.getAccountsCustomers({
          name: `${probeAccountName}/customers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createAccountsCustomers without Cloud Channel access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudchannel.createAccountsCustomers({
          parent: probeAccountName,
          body: probeCustomerBody,
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudChannel.Customer("Acme", {
            parent: probeAccountName,
            orgDisplayName: "Acme Corp",
          });
        }),
      );

      expect(created.name.startsWith(`${probeAccountName}/customers/`)).toEqual(
        true,
      );
      expect(created.customerId.length).toBeGreaterThan(0);
      expect(created.orgDisplayName).toEqual("Acme Corp");
      expect(created.domain).toEqual(expect.any(String));

      const fetched = yield* cloudchannel.getAccountsCustomers({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.orgDisplayName).toEqual("Acme Corp");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudChannel.Customer("Acme", {
            parent: probeAccountName,
            customerId: created.customerId,
            orgDisplayName: "Acme Corporation",
            domain: created.domain,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.orgDisplayName).toEqual("Acme Corporation");

      yield* stack.destroy();

      const gone = yield* waitUntilCustomerGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudchannel", "live"],
    timeout: 90_000,
  },
);
