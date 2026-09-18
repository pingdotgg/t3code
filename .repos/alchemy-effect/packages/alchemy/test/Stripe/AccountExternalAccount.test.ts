import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import { isMissingStripeResource } from "@/Stripe/missing.ts";
import * as Test from "@/Test/Alchemy";
import {
  DeleteAccount,
  GetAccountExternalAccount,
  CreateAccount,
  CreateToken,
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

/** Opt-in: the testing Stripe account must be a Connect platform. */
const CONNECT_ENABLED = process.env.STRIPE_TEST_CONNECT === "1";

const isMissing = isMissingStripeResource;

const waitUntilGone = (account: string, id: string) =>
  GetAccountExternalAccount({ account, id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const deleteAccount = (account: string) =>
  DeleteAccount({ account }).pipe(
    Effect.catchIf(isMissing, () => Effect.void),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError",
      () => Effect.void,
    ),
    Effect.asVoid,
  );

const createBankToken = (holderName: string) =>
  CreateToken({
    bank_account: {
      country: "US",
      currency: "usd",
      account_holder_name: holderName,
      account_holder_type: "individual",
      routing_number: "110000000",
      account_number: "000123456789",
    },
  });

const connectAccountProps = {
  type: "custom" as const,
  country: "US",
  capabilities: {
    transfers: { requested: true },
  },
  tosAcceptance: {
    date: 1_609_459_200,
    ip: "127.0.0.1",
  },
  businessType: "individual" as const,
  individual: {
    first_name: "Alchemy",
    last_name: "Tester",
  },
};

const probeConnectAccount = () =>
  CreateAccount({
    type: "custom",
    country: "US",
    email: "alchemy.account-external-account.probe@example.com",
    capabilities: {
      transfers: { requested: true },
    },
    tos_acceptance: {
      date: 1_609_459_200,
      ip: "127.0.0.1",
    },
    business_type: "individual",
    individual: {
      first_name: "Alchemy",
      last_name: "Tester",
    },
  });

test.provider(
  "connect accounts entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeConnectAccount().pipe(Effect.result);
      if (Result.isFailure(probe)) {
        expect(probe.failure._tag).not.toEqual("UnknownStripeError");
        expect(probe.failure._tag).toEqual("InvalidRequestError");
        expect(probe.failure.message ?? "").toContain("signed up for Connect");
        yield* stack.destroy();
        return;
      }

      yield* deleteAccount(probe.success.id);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "create, update, and delete an account external account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const token = yield* createBankToken("Jenny Rosen");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("ConnectAccount", {
            ...connectAccountProps,
            email: "alchemy.aea.lifecycle@example.com",
          });
          const externalAccount = yield* Stripe.AccountExternalAccount(
            "PayoutBank",
            {
              account: account.id,
              externalAccount: token.id,
              accountHolderName: "Jenny Rosen",
              accountHolderType: "individual",
              defaultForCurrency: true,
              metadata: { purpose: "payouts" },
            },
          );
          return { account, externalAccount };
        }),
      );

      expect(created.externalAccount.id).toMatch(/^(ba_|card_)/);
      expect(created.externalAccount.account).toEqual(created.account.id);
      expect(created.externalAccount.object).toEqual("bank_account");
      expect(created.externalAccount.last4).toEqual("6789");
      expect(created.externalAccount.country).toEqual("US");
      expect(created.externalAccount.currency).toEqual("usd");
      expect(created.externalAccount.accountHolderName).toEqual("Jenny Rosen");
      expect(created.externalAccount.accountHolderType).toEqual("individual");
      expect(created.externalAccount.defaultForCurrency).toEqual(true);
      expect(created.externalAccount.metadata).toMatchObject({
        purpose: "payouts",
      });
      expect(created.externalAccount.routingNumber).toEqual("110000000");

      const fetched = yield* GetAccountExternalAccount({
        account: created.externalAccount.account,
        id: created.externalAccount.id,
      });
      expect(fetched.id).toEqual(created.externalAccount.id);
      expect(fetched.object).toEqual("bank_account");
      if (fetched.object === "bank_account") {
        expect(fetched.last4).toEqual("6789");
        expect(fetched.account_holder_name).toEqual("Jenny Rosen");
        expect(fetched.account_holder_type).toEqual("individual");
        expect(fetched.metadata?.purpose).toEqual("payouts");
        expect(
          fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
        ).toBeDefined();
        expect(
          fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
        ).toBeDefined();
        expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("ConnectAccount", {
            ...connectAccountProps,
            email: "alchemy.aea.lifecycle@example.com",
          });
          const externalAccount = yield* Stripe.AccountExternalAccount(
            "PayoutBank",
            {
              account: account.id,
              externalAccount: token.id,
              accountHolderName: "Alchemy Tester",
              accountHolderType: "company",
              defaultForCurrency: true,
              metadata: { purpose: "payroll", region: "us" },
            },
          );
          return { account, externalAccount };
        }),
      );

      expect(updated.externalAccount.id).toEqual(created.externalAccount.id);
      expect(updated.externalAccount.account).toEqual(created.account.id);
      expect(updated.externalAccount.accountHolderName).toEqual(
        "Alchemy Tester",
      );
      expect(updated.externalAccount.accountHolderType).toEqual("company");
      expect(updated.externalAccount.metadata).toEqual({
        purpose: "payroll",
        region: "us",
      });

      const refetched = yield* GetAccountExternalAccount({
        account: updated.externalAccount.account,
        id: updated.externalAccount.id,
      });
      if (refetched.object === "bank_account") {
        expect(refetched.account_holder_name).toEqual("Alchemy Tester");
        expect(refetched.account_holder_type).toEqual("company");
        expect(refetched.metadata?.purpose).toEqual("payroll");
        expect(refetched.metadata?.region).toEqual("us");
        expect(
          refetched.metadata?.[Stripe.alchemyMetadataKeys.id],
        ).toBeDefined();
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.externalAccount.account,
        created.externalAccount.id,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "list enumerates the deployed account external account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const token = yield* createBankToken("List Holder");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* Stripe.Account("ListConnectAccount", {
            ...connectAccountProps,
            email: "alchemy.aea.list@example.com",
          });
          const externalAccount = yield* Stripe.AccountExternalAccount(
            "ListPayoutBank",
            {
              account: account.id,
              externalAccount: token.id,
              accountHolderName: "List Holder",
              metadata: { kind: "list" },
            },
          );
          return { account, externalAccount };
        }),
      );

      const provider = yield* Provider.findProvider(
        Stripe.AccountExternalAccount,
      );
      const all = yield* provider.list();
      const found = all.find((ea) => ea.id === deployed.externalAccount.id);
      expect(found).toBeDefined();
      expect(found?.account).toEqual(deployed.account.id);
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.last4).toEqual("6789");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.externalAccount.account,
        deployed.externalAccount.id,
      );
      expect(gone).toEqual("gone");

      const after = yield* provider.list();
      expect(
        after.find((ea) => ea.id === deployed.externalAccount.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
