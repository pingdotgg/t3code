import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  gmailpostmastertools.getDomains({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getDomains on a missing domain fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmailpostmastertools.getDomains({
          name: "domains/alchemy-missing.example.com",
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gmailpostmastertools", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createDomains without Postmaster Tools access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmailpostmastertools.createDomains({
          body: { domainId: "alchemy-probe.example.com" },
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gmailpostmastertools", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GmailPostmasterTools.Domain("Mail", {});
        }),
      );

      expect(created.name.startsWith("domains/")).toEqual(true);
      expect(created.domainId.length).toBeGreaterThan(0);
      expect(created.domainId.startsWith("alchemy-")).toEqual(true);

      const fetched = yield* gmailpostmastertools.getDomains({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GmailPostmasterTools.Domain("Mail", {
            domainId: created.domainId,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.domainId).toEqual(created.domainId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gmailpostmastertools", "live"],
    timeout: 90_000,
  },
);
