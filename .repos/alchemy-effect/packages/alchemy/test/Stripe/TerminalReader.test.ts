import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import { isMissingStripeResource } from "@/Stripe/missing.ts";
import * as Test from "@/Test/Alchemy";
import {
  GetTerminalReaders,
  GetTerminalReader,
  type DeletedTerminalReader,
  type TerminalReader as StripeTerminalReader,
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

const SIMULATED_REGISTRATION_CODE = "simulated-wpe";

const usAddress = {
  line1: "185 Berry Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94107",
  country: "US",
} as const;

const isDeletedReader = (
  value: StripeTerminalReader | DeletedTerminalReader,
): value is DeletedTerminalReader =>
  "deleted" in value && value.deleted === true;

const waitUntilGone = (id: string) =>
  GetTerminalReader({ reader: id }).pipe(
    Effect.map((reader) =>
      isDeletedReader(reader) ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "terminal readers entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* GetTerminalReaders({ limit: 1 }).pipe(
        Effect.result,
      );

      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.data)).toBe(true);
      } else {
        expect(result.failure._tag).not.toEqual("UnknownStripeError");
        expect(["InvalidRequestError", "Forbidden", "Unauthorized"]).toContain(
          result.failure._tag,
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider(
  "create, update, and delete a terminal reader",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const location = yield* Stripe.TerminalLocation(
            "ReaderLifecycleLocation",
            {
              displayName: "Alchemy Terminal Reader Lifecycle",
              address: { ...usAddress },
            },
          );
          const reader = yield* Stripe.TerminalReader("FrontCounter", {
            registrationCode: SIMULATED_REGISTRATION_CODE,
            label: "Alchemy Front Counter",
            location: location.id,
            metadata: { station: "1" },
          });
          return { location, reader };
        }),
      );

      expect(created.reader.id).toMatch(/^tmr_/);
      expect(created.reader.label).toEqual("Alchemy Front Counter");
      expect(created.reader.location).toEqual(created.location.id);
      expect(created.reader.deviceType).toEqual("simulated_wisepos_e");
      expect(created.reader.serialNumber.length).toBeGreaterThan(0);
      expect(created.reader.metadata).toMatchObject({ station: "1" });
      expect(created.reader.livemode).toEqual(false);

      const fetched = yield* GetTerminalReader({
        reader: created.reader.id,
      });
      expect(isDeletedReader(fetched)).toEqual(false);
      if (isDeletedReader(fetched)) return;
      expect(fetched.id).toEqual(created.reader.id);
      expect(fetched.label).toEqual("Alchemy Front Counter");
      expect(fetched.device_type).toEqual("simulated_wisepos_e");
      expect(fetched.metadata?.station).toEqual("1");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const location = yield* Stripe.TerminalLocation(
            "ReaderLifecycleLocation",
            {
              displayName: "Alchemy Terminal Reader Lifecycle",
              address: { ...usAddress },
            },
          );
          const reader = yield* Stripe.TerminalReader("FrontCounter", {
            registrationCode: SIMULATED_REGISTRATION_CODE,
            label: "Alchemy Front Counter Updated",
            location: location.id,
            metadata: { station: "1", floor: "lobby" },
          });
          return { location, reader };
        }),
      );

      expect(updated.reader.id).toEqual(created.reader.id);
      expect(updated.reader.label).toEqual("Alchemy Front Counter Updated");
      expect(updated.reader.location).toEqual(created.location.id);
      expect(updated.reader.metadata).toEqual({
        station: "1",
        floor: "lobby",
      });

      const refetched = yield* GetTerminalReader({
        reader: updated.reader.id,
      });
      expect(isDeletedReader(refetched)).toEqual(false);
      if (isDeletedReader(refetched)) return;
      expect(refetched.label).toEqual("Alchemy Front Counter Updated");
      expect(refetched.metadata?.station).toEqual("1");
      expect(refetched.metadata?.floor).toEqual("lobby");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.reader.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed terminal reader",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const location = yield* Stripe.TerminalLocation(
            "ReaderListLocation",
            {
              displayName: "Alchemy Terminal Reader List",
              address: { ...usAddress },
            },
          );
          const reader = yield* Stripe.TerminalReader("ListReader", {
            registrationCode: SIMULATED_REGISTRATION_CODE,
            label: "Alchemy List Reader",
            location: location.id,
            metadata: { kind: "list" },
          });
          return { location, reader };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.TerminalReader);
      const all = yield* provider.list();
      const found = all.find((reader) => reader.id === deployed.reader.id);
      expect(found).toBeDefined();
      expect(found?.label).toEqual("Alchemy List Reader");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.reader.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
