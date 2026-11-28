import { describe, expect, it } from "@effect/vitest";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Aead from "effect/crypto/Aead";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as AccountDeletion from "./AccountDeletion.ts";
import * as AccountEmails from "./AccountEmails.ts";
import * as SealedEmail from "./SealedEmail.ts";

const signingKey = new TextEncoder().encode("clerk-webhook-test-signing-key");
const signingSecret = `whsec_${Base64.encode(signingKey)}`;

const accountEmailKey = Redacted.make(Base64.encode(new Uint8Array(32).fill(7)));
const layerCrypto = Layer.mergeAll(Aead.layerWebCrypto, Mac.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

const config = {
  clerkWebhookSigningSecret: Redacted.make(signingSecret),
  accountEmailKey,
  managedEndpointNamespace: "dev",
} as unknown as RelayConfiguration.RelayConfiguration["Service"];

const SIGNED_AT_SECONDS = 1_800_000_000;
const OWN_TUNNEL = "t3coderelay-managedendpoint-dev-0123456789abcdef";

const clerkRequest = Effect.fn(function* (
  event: unknown,
  options: { readonly key?: Uint8Array } = {},
) {
  const body = JSON.stringify(event);
  const id = "msg_test";
  const timestamp = String(SIGNED_AT_SECONDS);
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, options.key ?? signingKey);
  const signature = yield* mac.sign(key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return HttpServerRequest.fromWeb(
    new Request("https://relay.test/v1/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${Base64.encode(signature)}`,
      },
      body,
    }),
  );
});

describe("Clerk webhook", () => {
  it.effect("keeps the primary email from user events and records signed deletions", () => {
    const requested: Array<string> = [];
    const respond = (request: ReturnType<typeof clerkRequest>) =>
      request.pipe(
        Effect.flatMap(AccountDeletion.handleClerkWebhook),
        Effect.map((response) => response.status),
      );
    return Effect.gen(function* () {
      yield* TestClock.setTime(SIGNED_AT_SECONDS * 1_000);
      const userDeleted = { type: "user.deleted", data: { id: "user_1", deleted: true } };
      expect(
        yield* respond(
          clerkRequest(userDeleted, { key: new TextEncoder().encode("some-other-signing-key") }),
        ),
      ).toBe(401);
      expect(requested).toEqual([]);
      const userUpdated = {
        type: "user.updated",
        data: {
          id: "user_1",
          primary_email_address_id: "idn_2",
          email_addresses: [
            { id: "idn_1", email_address: "old@example.com" },
            { id: "idn_2", email_address: "primary@example.com" },
          ],
        },
      };
      expect(yield* respond(clerkRequest(userUpdated))).toBe(200);
      expect(yield* respond(clerkRequest(userDeleted))).toBe(200);
      expect(requested).toEqual(["email user_1 primary@example.com", "delete user_1"]);
    }).pipe(
      Effect.provideService(RelayConfiguration.RelayConfiguration, config),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AccountDeletion.AccountDeletion, {
            recordEmail: ({ userId, email }) =>
              Effect.sync(() => void requested.push(`email ${userId} ${email}`)),
            request: ({ userId }) => Effect.sync(() => void requested.push(`delete ${userId}`)),
          }),
          layerCrypto,
        ),
      ),
    );
  });
});

const layerAccountDeletionTest = (fakeDb: RelayDb.RelayDb["Service"], calls: Array<string>) =>
  AccountDeletion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AccountEmails.AccountEmails, {
          sendDeletionNotice: ({ to }) =>
            to.startsWith("bounce")
              ? Effect.fail(new AccountEmails.AccountEmailFailed({ cause: new Error("rejected") }))
              : Effect.sync(() => void calls.push(`notice ${to}`)),
        }),
        layerCrypto,
        Layer.succeed(RelayDb.RelayDb, fakeDb),
        Layer.succeed(RelayDb.RelayTransactions, { withTransaction: (effect) => effect }),
        Layer.succeed(RelayConfiguration.RelayConfiguration, config),
        Layer.mock(T3ChatAccounts.T3ChatAccounts, {
          available: true,
          getLink: () => Effect.succeed({} as never),
          unlink: ({ userId }) =>
            userId === "user_broken"
              ? Effect.fail(
                  new T3ChatAccounts.T3ChatRequestFailed({
                    operation: "unlink",
                    cause: new Error("unavailable"),
                  }),
                )
              : Effect.sync(() => void calls.push(`unlink-t3chat ${userId}`)),
        }),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {
          getForUser: () => Effect.succeed(null),
        }),
        Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
        Layer.mock(HookInbox.HookInbox, {
          clear: ({ endpointKey }) => Effect.sync(() => void calls.push(`clear ${endpointKey}`)),
        }),
        Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: ({ environmentId }) =>
            Effect.sync(() => {
              calls.push(`deprovision ${environmentId}`);
              return true;
            }),
        }),
      ),
    ),
  );

const dialect = new PgDialect();
const params = (condition: SQL | undefined) =>
  condition === undefined ? [] : dialect.sqlToQuery(condition).params;

describe("AccountDeletion", () => {
  it.effect(
    "tears down tunnels, then locks each environment identity before deleting its rows",
    () => {
      const calls: Array<string> = [];
      let linksAtDelete: ReadonlyArray<{ environmentId: string; environmentPublicKey: string }> =
        [];
      const ownLinks = [
        { environmentId: "env-shared", environmentPublicKey: "key-b" },
        { environmentId: "env-own", environmentPublicKey: "key-a" },
      ];
      const fakeDb = {
        execute: (query: SQL) =>
          Effect.sync(() => {
            calls.push(`lock ${params(query).join(",")}`);
          }),
        select: () => ({
          from: (table: Table) => ({
            where: (condition: SQL | undefined) => {
              const name = getTableName(table);
              const rows = Effect.sync(() => {
                calls.push(`select ${name} ${params(condition).join(",")}`);
                if (name === "relay_environment_links") return ownLinks;
                // Teardown removed the allocation, so the remaining-allocation check finds none.
                return calls.some((call) => call.startsWith("deprovision"))
                  ? []
                  : [{ environmentId: "env-own", tunnelName: OWN_TUNNEL }];
              });
              // The per-identity check after the user's links are deleted: another account
              // still links env-shared under the same key.
              return Object.assign(rows, {
                limit: () =>
                  Effect.succeed(
                    params(condition).includes("env-shared")
                      ? [{ environmentId: "env-shared" }]
                      : [],
                  ),
              });
            },
          }),
        }),
        delete: (table: Table) => ({
          where: (condition: SQL | undefined) => {
            const done = Effect.sync(() => {
              calls.push(`delete ${getTableName(table)} ${params(condition).join(",")}`);
            });
            return Object.assign(done, {
              returning: () => Effect.as(done, linksAtDelete),
            });
          },
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      linksAtDelete = ownLinks;
      return Effect.gen(function* () {
        const accounts = yield* AccountDeletion.AccountDeletion;
        yield* accounts.deleteAccount({ userId: "user_1" });
        expect(calls.filter((call) => !call.startsWith("select"))).toEqual([
          "clear 0123456789abcdef",
          "deprovision env-shared",
          "deprovision env-own",
          "lock env-own,key-a",
          "lock env-shared,key-b",
          "delete relay_environment_links user_1",
          "delete relay_environment_credentials env-own,key-a",
          "delete relay_agent_activity_rows env-own,key-a",
          "delete relay_live_activities user_1",
          "delete relay_mobile_devices user_1",
          "delete relay_delivery_attempts user_1",
          "delete relay_managed_tunnel_limits user_1",
          "delete relay_account_emails user_1",
          "unlink-t3chat user_1",
        ]);

        // A link with a new key committed after the identities were read: the pass rolls back
        // before deleting anything it has not locked, and the next sweep starts over.
        calls.length = 0;
        linksAtDelete = [
          ...ownLinks,
          { environmentId: "env-own", environmentPublicKey: "key-new" },
        ];
        const failure = yield* Effect.flip(accounts.deleteAccount({ userId: "user_1" }));
        expect(failure.stage).toBe("delete-rows");
        expect(calls.filter((call) => call.startsWith("delete")).at(-1)).toBe(
          "delete relay_environment_links user_1",
        );
      }).pipe(Effect.provide(layerAccountDeletionTest(fakeDb, calls)));
    },
  );

  it.effect("keeps retrying a deletion until a pass succeeds after relay tokens expire", () => {
    const calls: Array<string> = [];
    const pending = [
      { userId: "user_settled", requestedAt: "2026-11-24T11:00:00.000Z", attempts: 0 },
      { userId: "user_fresh", requestedAt: "2026-11-24T11:59:00.000Z", attempts: 0 },
      { userId: "user_broken", requestedAt: "2026-11-24T11:00:00.000Z", attempts: 2 },
    ];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Effect.succeed([]), {
              orderBy: () => ({ limit: () => Effect.succeed(pending) }),
              limit: () => Effect.succeed([]),
            }),
        }),
      }),
      update: (table: Table) => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL | undefined) =>
            Effect.sync(() => {
              const action = "completedAt" in values ? "complete" : "retry";
              calls.push(`${action} ${getTableName(table)} ${params(condition).join(",")}`);
            }),
        }),
      }),
      delete: (table: Table) => ({
        where: (condition: SQL | undefined) => {
          const done = Effect.sync(() => {
            calls.push(`delete ${getTableName(table)} ${params(condition).join(",")}`);
          });
          return Object.assign(done, { returning: () => Effect.as(done, []) });
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-24T12:00:00.000Z"));
      const accounts = yield* AccountDeletion.AccountDeletion;
      expect(yield* accounts.processPending).toEqual({ completed: 1, failed: 1 });
      expect(calls).toContain("delete relay_mobile_devices user_fresh");
      expect(calls.filter((call) => call.includes("relay_account_deletions"))).toEqual([
        "complete relay_account_deletions user_settled",
        "retry relay_account_deletions user_broken",
      ]);
    }).pipe(Effect.provide(layerAccountDeletionTest(fakeDb, calls)));
  });

  it.effect("sends each deletion notice once, and gives up on one that fails for a day", () => {
    const calls: Array<string> = [];
    const notices: Array<{
      userId: string;
      completedAt: string;
      encryptedNotifyEmail: string;
    }> = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Effect.succeed([]), {
              orderBy: () => ({ limit: () => Effect.succeed([]) }),
              limit: () => Effect.succeed(notices),
            }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL | undefined) =>
            Effect.sync(() => {
              if (values.encryptedNotifyEmail === null) {
                calls.push(`clear ${params(condition).join(",")}`);
              }
            }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const notice = Effect.fn(function* (userId: string, completedAt: string, email: string) {
        const encryptedNotifyEmail = yield* SealedEmail.seal(accountEmailKey, { userId, email });
        notices.push({ userId, completedAt, encryptedNotifyEmail });
      });
      yield* notice("user_done", "2026-11-24T11:30:00.000Z", "done@example.com");
      yield* notice("user_bounce", "2026-11-24T11:30:00.000Z", "bounce@example.com");
      yield* notice("user_old", "2026-11-22T11:00:00.000Z", "bounce-old@example.com");
      yield* TestClock.setTime(Date.parse("2026-11-24T12:00:00.000Z"));
      const accounts = yield* AccountDeletion.AccountDeletion;
      yield* accounts.processPending;
      expect(calls).toEqual(["notice done@example.com", "clear user_done", "clear user_old"]);
    }).pipe(Effect.provide(Layer.merge(layerAccountDeletionTest(fakeDb, calls), layerCrypto)));
  });
});

describe("SealedEmail", () => {
  it.effect("opens only for the account it was sealed for", () =>
    Effect.gen(function* () {
      const sealed = yield* SealedEmail.seal(accountEmailKey, {
        userId: "user_1",
        email: "a@example.com",
      });
      expect(sealed).not.toContain("example.com");
      expect(yield* SealedEmail.open(accountEmailKey, { userId: "user_1", sealed })).toBe(
        "a@example.com",
      );
      yield* Effect.flip(SealedEmail.open(accountEmailKey, { userId: "user_2", sealed }));
    }).pipe(Effect.provide(layerCrypto)),
  );
});
