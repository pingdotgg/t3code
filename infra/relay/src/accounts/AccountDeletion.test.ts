import { describe, expect, it } from "@effect/vitest";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

const signingKey = new TextEncoder().encode("clerk-webhook-test-signing-key");
const signingSecret = `whsec_${Base64.encode(signingKey)}`;

const config = {
  clerkWebhookSigningSecret: Redacted.make(signingSecret),
  managedEndpointNamespace: undefined,
} as unknown as RelayConfiguration.RelayConfiguration["Service"];

const SIGNED_AT_SECONDS = 1_800_000_000;

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
  it.effect("deletes only for a signed user.deleted event", () => {
    const deleted: Array<string> = [];
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
      expect(yield* respond(clerkRequest({ type: "user.created", data: { id: "user_2" } }))).toBe(
        204,
      );
      expect(deleted).toEqual([]);
      expect(yield* respond(clerkRequest(userDeleted))).toBe(204);
      expect(deleted).toEqual(["user_1"]);
    }).pipe(
      Effect.provideService(RelayConfiguration.RelayConfiguration, config),
      Effect.provideService(AccountDeletion.AccountDeletion, {
        deleteAccount: ({ userId }) => Effect.sync(() => void deleted.push(userId)),
      }),
      Effect.provide(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
    );
  });
});

describe("AccountDeletion", () => {
  it.effect(
    "tears down tunnels before deleting rows and keeps environments another account links",
    () => {
      const calls: Array<string> = [];
      const dialect = new PgDialect();
      const params = (condition: SQL | undefined) =>
        condition === undefined ? [] : dialect.sqlToQuery(condition).params;
      const selects: Record<string, ReadonlyArray<{ environmentId: string }>> = {
        relay_environment_links: [{ environmentId: "env-own" }, { environmentId: "env-shared" }],
        relay_managed_endpoint_allocations: [{ environmentId: "env-own" }],
      };
      const fakeDb = {
        select: () => ({
          from: (table: Table) => ({
            where: (condition: SQL | undefined) =>
              Effect.sync(() => {
                const name = getTableName(table);
                // After the user's links are gone, only the other account's link remains.
                if (calls.includes("delete relay_environment_links user_1")) {
                  return name === "relay_environment_links"
                    ? [{ environmentId: "env-shared" }]
                    : [];
                }
                calls.push(`select ${name} ${params(condition).join(",")}`);
                return calls.some((call) => call.startsWith("deprovision")) &&
                  name === "relay_managed_endpoint_allocations"
                  ? []
                  : (selects[name] ?? []);
              }),
          }),
        }),
        delete: (table: Table) => ({
          where: (condition: SQL | undefined) =>
            Effect.sync(() => {
              calls.push(`delete ${getTableName(table)} ${params(condition).join(",")}`);
            }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const accounts = yield* AccountDeletion.AccountDeletion;
        yield* accounts.deleteAccount({ userId: "user_1" });
        expect(calls.filter((call) => !call.startsWith("select"))).toEqual([
          "deprovision env-own",
          "deprovision env-shared",
          "delete relay_environment_links user_1",
          "delete relay_environment_credentials env-own",
          "delete relay_agent_activity_rows env-own",
          "delete relay_live_activities user_1",
          "delete relay_mobile_devices user_1",
          "delete relay_delivery_attempts user_1",
          "delete relay_managed_tunnel_limits user_1",
          "unlink-t3chat user_1",
        ]);
      }).pipe(
        Effect.provide(
          AccountDeletion.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(RelayDb.RelayDb, fakeDb),
                Layer.succeed(RelayDb.RelayTransactions, { withTransaction: (effect) => effect }),
                Layer.succeed(RelayConfiguration.RelayConfiguration, config),
                Layer.mock(T3ChatAccounts.T3ChatAccounts, {
                  available: true,
                  getLink: () => Effect.succeed({} as never),
                  unlink: ({ userId }) =>
                    Effect.sync(() => void calls.push(`unlink-t3chat ${userId}`)),
                }),
                Layer.mock(EnvironmentLinks.EnvironmentLinks, {
                  getForUser: () => Effect.succeed(null),
                }),
                Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
                Layer.mock(HookInbox.HookInbox, {}),
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
          ),
        ),
      );
    },
  );
});
