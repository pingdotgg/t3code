import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { isMissingStripeResource } from "@/Stripe/missing.ts";
import {
  DeleteAccount,
  GetAccountPerson,
  CreateAccount,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const CONNECT_ENABLED = process.env.STRIPE_TEST_CONNECT === "1";

const isMissing = isMissingStripeResource;

const waitUntilGone = (account: string, person: string) =>
  GetAccountPerson({ account, person }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeConnectAccount = CreateAccount({
  type: "custom",
  country: "US",
  email: "alchemy.account.person.probe@example.com",
  business_type: "company",
  company: { name: "Alchemy Account Person Probe" },
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
});

test.provider(
  "connect accounts entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeConnectAccount.pipe(Effect.result);
      if (Result.isFailure(probe)) {
        expect(probe.failure._tag).not.toEqual("UnknownStripeError");
        expect(probe.failure._tag).toEqual("InvalidRequestError");
        if (probe.failure._tag === "InvalidRequestError") {
          expect(probe.failure.message ?? "").toContain(
            "signed up for Connect",
          );
        }
        yield* stack.destroy();
        return;
      }

      yield* DeleteAccount({ account: probe.success.id }).pipe(
        Effect.catchIf(isMissing, () => Effect.void),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "create, update, and delete an account person",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("PersonLifecycleAccount", {
            type: "custom",
            country: "US",
            email: "alchemy.account.person.lifecycle@example.com",
            businessType: "company",
            company: { name: "Alchemy Account Person Co" },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
          });
          const person = yield* Stripe.AccountPerson("CatalogPerson", {
            account: account.id,
            firstName: "Jane",
            lastName: "Diaz",
            email: "jane.diaz@example.com",
            phone: "+15555550100",
            relationship: { director: true, title: "CFO" },
            metadata: { role: "finance" },
          });
          return { account, person };
        }),
      );

      expect(created.person.id).toMatch(/^person_/);
      expect(created.person.account).toEqual(created.account.id);
      expect(created.person.firstName).toEqual("Jane");
      expect(created.person.lastName).toEqual("Diaz");
      expect(created.person.email).toEqual("jane.diaz@example.com");
      expect(created.person.phone).toEqual("+15555550100");
      expect(created.person.relationship?.director).toEqual(true);
      expect(created.person.relationship?.title).toEqual("CFO");
      expect(created.person.metadata).toMatchObject({ role: "finance" });
      expect(created.person.created).toEqual(expect.any(Number));

      const fetched = yield* GetAccountPerson({
        account: created.account.id,
        person: created.person.id,
      });
      expect(fetched.id).toEqual(created.person.id);
      expect(fetched.first_name).toEqual("Jane");
      expect(fetched.last_name).toEqual("Diaz");
      expect(fetched.email).toEqual("jane.diaz@example.com");
      expect(fetched.phone).toEqual("+15555550100");
      expect(fetched.relationship?.director).toEqual(true);
      expect(fetched.relationship?.title).toEqual("CFO");
      expect(fetched.metadata?.role).toEqual("finance");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("PersonLifecycleAccount", {
            type: "custom",
            country: "US",
            email: "alchemy.account.person.lifecycle@example.com",
            businessType: "company",
            company: { name: "Alchemy Account Person Co" },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
          });
          const person = yield* Stripe.AccountPerson("CatalogPerson", {
            account: account.id,
            firstName: "Janet",
            lastName: "Diaz-Kim",
            email: "janet.diaz@example.com",
            phone: "+15555550199",
            relationship: { director: true, title: "COO" },
            metadata: { role: "ops", sku: "exec-1" },
          });
          return { account, person };
        }),
      );

      expect(updated.person.id).toEqual(created.person.id);
      expect(updated.person.account).toEqual(created.account.id);
      expect(updated.person.firstName).toEqual("Janet");
      expect(updated.person.lastName).toEqual("Diaz-Kim");
      expect(updated.person.email).toEqual("janet.diaz@example.com");
      expect(updated.person.phone).toEqual("+15555550199");
      expect(updated.person.relationship?.title).toEqual("COO");
      expect(updated.person.metadata).toEqual({ role: "ops", sku: "exec-1" });

      const refetched = yield* GetAccountPerson({
        account: updated.account.id,
        person: updated.person.id,
      });
      expect(refetched.first_name).toEqual("Janet");
      expect(refetched.last_name).toEqual("Diaz-Kim");
      expect(refetched.email).toEqual("janet.diaz@example.com");
      expect(refetched.phone).toEqual("+15555550199");
      expect(refetched.relationship?.title).toEqual("COO");
      expect(refetched.metadata?.role).toEqual("ops");
      expect(refetched.metadata?.sku).toEqual("exec-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.account.id, created.person.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "list enumerates the deployed account person",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("PersonListAccount", {
            type: "custom",
            country: "US",
            email: "alchemy.account.person.list@example.com",
            businessType: "company",
            company: { name: "Alchemy Account Person List Co" },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
          });
          const person = yield* Stripe.AccountPerson("ListPerson", {
            account: account.id,
            firstName: "Lee",
            lastName: "Park",
            email: "lee.park@example.com",
            relationship: { director: true },
            metadata: { kind: "list" },
          });
          return { account, person };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.AccountPerson);
      const all = yield* provider.list();
      const found = all.find((person) => person.id === deployed.person.id);
      expect(found).toBeDefined();
      expect(found?.account).toEqual(deployed.account.id);
      expect(found?.firstName).toEqual("Lee");
      expect(found?.lastName).toEqual("Park");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.account.id,
        deployed.person.id,
      );
      expect(gone).toEqual("gone");

      const after = yield* provider.list();
      expect(
        after.find((person) => person.id === deployed.person.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
