// @effect-diagnostics-next-line nodeBuiltinImport:off -- signs Svix test payloads like Clerk does.
import * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as AccountDeletion from "./AccountDeletion.ts";

const signingKey = NodeCrypto.randomBytes(24);
const signingSecret = `whsec_${signingKey.toString("base64")}`;

const config = {
  clerkWebhookSigningSecret: Redacted.make(signingSecret),
  managedEndpointNamespace: undefined,
} as unknown as RelayConfiguration.RelayConfiguration["Service"];

// Svix compares the signed timestamp with the system clock, so pin both to one epoch.
const SIGNED_AT_SECONDS = 1_800_000_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIGNED_AT_SECONDS * 1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const clerkRequest = (event: unknown, options: { readonly secret?: Buffer } = {}) => {
  const body = JSON.stringify(event);
  const id = "msg_test";
  const timestamp = String(SIGNED_AT_SECONDS);
  const signature = NodeCrypto.createHmac("sha256", options.secret ?? signingKey)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return HttpServerRequest.fromWeb(
    new Request("https://relay.test/v1/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body,
    }),
  );
};

describe("Clerk webhook", () => {
  it.effect("deletes only for a signed user.deleted event", () => {
    const deleted: Array<string> = [];
    const respond = (request: HttpServerRequest.HttpServerRequest) =>
      AccountDeletion.handleClerkWebhook(request).pipe(Effect.map((response) => response.status));
    return Effect.gen(function* () {
      const userDeleted = { type: "user.deleted", data: { id: "user_1", deleted: true } };
      expect(
        yield* respond(clerkRequest(userDeleted, { secret: NodeCrypto.randomBytes(24) })),
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
