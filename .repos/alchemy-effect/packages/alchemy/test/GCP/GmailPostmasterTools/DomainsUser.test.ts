import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  gmailpostmastertools.getDomainsUsers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getDomainsUsers on a missing user fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmailpostmastertools.getDomainsUsers({
          name: "domains/alchemy-missing.example.com/users/missing@example.com",
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
  "createDomainsUsers without Postmaster Tools access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmailpostmastertools.createDomainsUsers({
          parent: "domains/alchemy-missing.example.com",
          body: {
            userId: "alchemy-probe@example.com",
            permission: "READER",
          },
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
  "create, update, and delete a domain user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.GmailPostmasterTools.Domain("Mail", {});
          const user = yield* GCP.GmailPostmasterTools.DomainsUser("Ada", {
            parent: domain.name,
            permission: "READER",
          });
          return { domain, user };
        }),
      );

      expect(created.user.parent).toEqual(created.domain.name);
      expect(created.user.userId.startsWith("alchemy-")).toEqual(true);
      expect(created.user.permission).toEqual("READER");

      const fetched = yield* gmailpostmastertools.getDomainsUsers({
        name: created.user.name,
      });
      expect(fetched.permission).toEqual("READER");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.GmailPostmasterTools.Domain("Mail", {
            domainId: created.domain.domainId,
          });
          const user = yield* GCP.GmailPostmasterTools.DomainsUser("Ada", {
            parent: domain.name,
            userId: created.user.userId,
            permission: "ADMIN",
          });
          return { domain, user };
        }),
      );

      expect(updated.user.name).toEqual(created.user.name);
      expect(updated.user.permission).toEqual("ADMIN");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.user.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gmailpostmastertools", "live"],
    timeout: 90_000,
  },
);
