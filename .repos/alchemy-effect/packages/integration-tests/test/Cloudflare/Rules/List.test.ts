import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rules from "@distilled.cloud/cloudflare/rules";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";
import { expectUrlRedirect, waitForDns } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getList = (accountId: string, listId: string) =>
  rules.getList({ accountId, listId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const getItems = (accountId: string, listId: string) =>
  rules.listListItems.items({ accountId, listId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Bulk Redirects live in the account's `http_request_redirect` phase
// entrypoint, available on every plan. An entrypoint that never materialized
// reads as empty.
const getEntrypoint = (accountId: string) =>
  rulesets.getPhasForAccount({ accountId, rulesetPhase: "http_request_redirect" }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
    Effect.map((entrypoint) => ({ rules: entrypoint.rules ?? [] })),
    Effect.catchTag("RulesetNotFound", () => Effect.succeed({ rules: [] })),
  );

const zoneName = "alchemy-test-2.us";

const expectGone = (accountId: string, listId: string) =>
  getList(accountId, listId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ListNotDeleted" } as const)),
    // A missing list surfaces as `ListNotFound` (Cloudflare error code
    // 10001) — that's the success condition here.
    Effect.catchTag("ListNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ListNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );

test.provider(
  "create and delete an ip list with default name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const list = yield* stack.deploy(
        Cloudflare.Rules.List("DefaultList", {
          kind: "ip",
          description: "alchemy rules list create test",
          items: [{ ip: "203.0.113.7", comment: "scanner" }, { ip: "198.51.100.0/24" }],
        }),
      );

      expect(list.listId).toBeDefined();
      expect(list.accountId).toEqual(accountId);
      expect(list.kind).toEqual("ip");
      expect(list.description).toEqual("alchemy rules list create test");
      // List names only allow letters, numbers, and underscores.
      expect(list.name).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(list.numItems).toEqual(2);

      const live = yield* getList(accountId, list.listId);
      expect(live.name).toEqual(list.name);
      expect(live.kind).toEqual("ip");

      const items = yield* getItems(accountId, list.listId);
      const ips = items.map((item) => ("ip" in item ? item.ip : undefined)).sort();
      expect(ips).toEqual(["198.51.100.0/24", "203.0.113.7"]);

      yield* stack.destroy();

      yield* expectGone(accountId, list.listId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"] },
);

test.provider(
  "update description and items in place (same listId)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.Rules.List("UpdateList", {
          name: testName("alchemy_rules_list_update", "_"),
          kind: "ip",
          description: "v1",
          items: [{ ip: "203.0.113.1" }, { ip: "203.0.113.2" }],
        }),
      );

      expect(initial.name).toEqual(testName("alchemy_rules_list_update", "_"));
      expect(initial.description).toEqual("v1");
      expect(initial.numItems).toEqual(2);

      const updated = yield* stack.deploy(
        Cloudflare.Rules.List("UpdateList", {
          name: testName("alchemy_rules_list_update", "_"),
          kind: "ip",
          description: "v2",
          items: [{ ip: "203.0.113.2", comment: "kept" }, { ip: "192.0.2.0/24" }],
        }),
      );

      // Same list mutated in place — not a replacement.
      expect(updated.listId).toEqual(initial.listId);
      expect(updated.description).toEqual("v2");
      expect(updated.numItems).toEqual(2);

      const items = yield* getItems(accountId, updated.listId);
      const ips = items.map((item) => ("ip" in item ? item.ip : undefined)).sort();
      expect(ips).toEqual(["192.0.2.0/24", "203.0.113.2"]);
      const kept = items.find((item) => "ip" in item && item.ip === "203.0.113.2");
      expect(kept && "comment" in kept ? kept.comment : undefined).toEqual("kept");

      // Redeploying identical props is a no-op (still the same list).
      const noop = yield* stack.deploy(
        Cloudflare.Rules.List("UpdateList", {
          name: testName("alchemy_rules_list_update", "_"),
          kind: "ip",
          description: "v2",
          items: [{ ip: "203.0.113.2", comment: "kept" }, { ip: "192.0.2.0/24" }],
        }),
      );
      expect(noop.listId).toEqual(initial.listId);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.listId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"] },
);

test.provider(
  "changing kind replaces the list",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const ipList = yield* stack.deploy(
        Cloudflare.Rules.List("ReplaceList", {
          name: testName("alchemy_rules_list_replace", "_"),
          kind: "ip",
          items: [{ ip: "203.0.113.9" }],
        }),
      );
      expect(ipList.kind).toEqual("ip");

      const hostnameList = yield* stack.deploy(
        Cloudflare.Rules.List("ReplaceList", {
          name: testName("alchemy_rules_list_replace", "_"),
          kind: "hostname",
          items: [{ hostname: { urlHostname: "example.com" } }],
        }),
      );

      // Kind is immutable — the engine must replace the list.
      expect(hostnameList.listId).not.toEqual(ipList.listId);
      expect(hostnameList.kind).toEqual("hostname");

      // The old list is gone, the new one is live.
      yield* expectGone(accountId, ipList.listId);
      const live = yield* getList(accountId, hostnameList.listId);
      expect(live.kind).toEqual("hostname");

      yield* stack.destroy();

      yield* expectGone(accountId, hostnameList.listId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"] },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const list = yield* stack.deploy(
        Cloudflare.Rules.List("HealList", {
          name: testName("alchemy_rules_list_heal", "_"),
          kind: "ip",
          items: [{ ip: "203.0.113.11" }],
        }),
      );

      // Delete the list out-of-band. A redeploy with identical props is a
      // planner no-op, so change a prop to force reconcile — it must observe
      // the list as missing and recreate it instead of failing on a 404.
      yield* rules.deleteList({ accountId, listId: list.listId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      const healed = yield* stack.deploy(
        Cloudflare.Rules.List("HealList", {
          name: testName("alchemy_rules_list_heal", "_"),
          kind: "ip",
          description: "healed",
          items: [{ ip: "203.0.113.11" }],
        }),
      );

      expect(healed.listId).not.toEqual(list.listId);
      expect(healed.description).toEqual("healed");
      const live = yield* getList(accountId, healed.listId);
      expect(live.name).toEqual(testName("alchemy_rules_list_heal", "_"));

      yield* stack.destroy();

      yield* expectGone(accountId, healed.listId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"] },
);

test.provider(
  "adopts an existing list with the same name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create a list out-of-band with the exact name the resource will use —
      // the create conflict (`ListAlreadyExists`, code 10021) must resolve by
      // adopting the existing list.
      const preexisting = yield* rules
        .createList({ accountId, name: testName("alchemy_rules_list_adopt", "_"), kind: "ip" })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
          Effect.catchTag("ListAlreadyExists", () =>
            rules.listLists.items({ accountId }).pipe(
              Stream.filter((l) => l.name === testName("alchemy_rules_list_adopt", "_")),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          ),
        );

      const adopted = yield* stack.deploy(
        Cloudflare.Rules.List("AdoptList", {
          name: testName("alchemy_rules_list_adopt", "_"),
          kind: "ip",
          description: "adopted",
          items: [{ ip: "203.0.113.21" }],
        }),
      );

      expect(adopted.listId).toEqual(preexisting.id);
      expect(adopted.description).toEqual("adopted");
      expect(adopted.numItems).toEqual(1);

      yield* stack.destroy();

      yield* expectGone(accountId, preexisting.id);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"] },
);

test.provider(
  "redirect list drives a Bulk Redirect rule",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({ accountId, name: zoneName });
      if (!zone) return yield* Effect.die(`test zone ${zoneName} not found`);
      const hostname = `bulk-redirect-${stack.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.${zoneName}`;

      yield* stack.destroy();

      const bulkRedirects = (items: Cloudflare.Rules.ListItem[]) =>
        Effect.gen(function* () {
          yield* Cloudflare.DNS.Record("BulkRedirectHost", {
            zoneId: zone.id,
            name: hostname,
            type: "A",
            content: "192.0.2.1",
            proxied: true,
          });
          const list = yield* Cloudflare.Rules.List("RetiredSlugs", {
            kind: "redirect",
            items,
          });
          const entrypoint = yield* Cloudflare.Ruleset.AccountEntrypoint("BulkRedirects", {
            phase: "http_request_redirect",
            rules: [
              {
                ref: "retired_slugs",
                expression: Output.interpolate`http.request.full_uri in $${list.name}`,
                action: "redirect",
                actionParameters: {
                  fromList: { name: list.name, key: "http.request.full_uri" },
                },
              },
            ],
          });
          return { list, entrypoint };
        });

      const redirect = (from: string, to: string): Cloudflare.Rules.ListItem => ({
        redirect: {
          sourceUrl: `${hostname}/${from}`,
          targetUrl: `https://${hostname}/${to}`,
          statusCode: 301,
          preserveQueryString: true,
        },
      });

      const v1 = yield* stack.deploy(
        bulkRedirects([redirect("old-a", "new-a"), redirect("old-b", "new-b")]),
      );

      expect(v1.list.numItems).toEqual(2);
      const live = yield* getEntrypoint(accountId);
      expect(live.rules).toHaveLength(1);
      expect(live.rules[0]).toMatchObject({
        action: "redirect",
        actionParameters: {
          fromList: { name: v1.list.name, key: "http.request.full_uri" },
        },
      });

      // The proxied record is brand new; confirm it on the authoritative
      // nameservers before the first fetch so no resolver caches NXDOMAIN.
      yield* waitForDns(hostname);
      yield* expectUrlRedirect(`https://${hostname}/old-a`, "/new-a");
      yield* expectUrlRedirect(`https://${hostname}/old-b`, "/new-b");

      // Adding a mapping only touches the list — the single rule is unchanged.
      const v2 = yield* stack.deploy(
        bulkRedirects([
          redirect("old-a", "new-a"),
          redirect("old-b", "new-b"),
          redirect("old-c", "new-c"),
        ]),
      );
      expect(v2.list.listId).toEqual(v1.list.listId);
      expect(v2.list.numItems).toEqual(3);
      expect(v2.entrypoint.rules).toHaveLength(1);

      yield* expectUrlRedirect(`https://${hostname}/old-c`, "/new-c");

      yield* stack.destroy();

      yield* expectGone(accountId, v1.list.listId);
      const after = yield* getEntrypoint(accountId);
      expect(after.rules).toHaveLength(0);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:rules", "live"],
    timeout: 300_000,
  },
);
