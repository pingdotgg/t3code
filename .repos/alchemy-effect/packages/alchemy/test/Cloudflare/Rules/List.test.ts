import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as rules from "@distilled.cloud/cloudflare/rules";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

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

const expectGone = (accountId: string, listId: string) =>
  getList(accountId, listId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ListNotDeleted" } as const)),
    // A missing list surfaces as `ListNotFound` (Cloudflare error code
    // 10001) — that's the success condition here.
    Effect.catchTag("ListNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ListNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete an ip list with default name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const list = yield* stack.deploy(
      Cloudflare.Rules.List("DefaultList", {
        kind: "ip",
        description: "alchemy rules list create test",
        items: [
          { ip: "203.0.113.7", comment: "scanner" },
          { ip: "198.51.100.0/24" },
        ],
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
    const ips = items
      .map((item) => ("ip" in item ? item.ip : undefined))
      .sort();
    expect(ips).toEqual(["198.51.100.0/24", "203.0.113.7"]);

    yield* stack.destroy();

    yield* expectGone(accountId, list.listId);
  }).pipe(logLevel),
);

test.provider("update description and items in place (same listId)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Rules.List("UpdateList", {
        name: "alchemy_rules_list_update",
        kind: "ip",
        description: "v1",
        items: [{ ip: "203.0.113.1" }, { ip: "203.0.113.2" }],
      }),
    );

    expect(initial.name).toEqual("alchemy_rules_list_update");
    expect(initial.description).toEqual("v1");
    expect(initial.numItems).toEqual(2);

    const updated = yield* stack.deploy(
      Cloudflare.Rules.List("UpdateList", {
        name: "alchemy_rules_list_update",
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
    const ips = items
      .map((item) => ("ip" in item ? item.ip : undefined))
      .sort();
    expect(ips).toEqual(["192.0.2.0/24", "203.0.113.2"]);
    const kept = items.find(
      (item) => "ip" in item && item.ip === "203.0.113.2",
    );
    expect(kept && "comment" in kept ? kept.comment : undefined).toEqual(
      "kept",
    );

    // Redeploying identical props is a no-op (still the same list).
    const noop = yield* stack.deploy(
      Cloudflare.Rules.List("UpdateList", {
        name: "alchemy_rules_list_update",
        kind: "ip",
        description: "v2",
        items: [{ ip: "203.0.113.2", comment: "kept" }, { ip: "192.0.2.0/24" }],
      }),
    );
    expect(noop.listId).toEqual(initial.listId);

    yield* stack.destroy();

    yield* expectGone(accountId, initial.listId);
  }).pipe(logLevel),
);

test.provider("changing kind replaces the list", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const ipList = yield* stack.deploy(
      Cloudflare.Rules.List("ReplaceList", {
        name: "alchemy_rules_list_replace",
        kind: "ip",
        items: [{ ip: "203.0.113.9" }],
      }),
    );
    expect(ipList.kind).toEqual("ip");

    const hostnameList = yield* stack.deploy(
      Cloudflare.Rules.List("ReplaceList", {
        name: "alchemy_rules_list_replace",
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
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const list = yield* stack.deploy(
      Cloudflare.Rules.List("HealList", {
        name: "alchemy_rules_list_heal",
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
        name: "alchemy_rules_list_heal",
        kind: "ip",
        description: "healed",
        items: [{ ip: "203.0.113.11" }],
      }),
    );

    expect(healed.listId).not.toEqual(list.listId);
    expect(healed.description).toEqual("healed");
    const live = yield* getList(accountId, healed.listId);
    expect(live.name).toEqual("alchemy_rules_list_heal");

    yield* stack.destroy();

    yield* expectGone(accountId, healed.listId);
  }).pipe(logLevel),
);

test.provider("adopts an existing list with the same name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create a list out-of-band with the exact name the resource will use —
    // the create conflict (`ListAlreadyExists`, code 10021) must resolve by
    // adopting the existing list.
    const preexisting = yield* rules
      .createList({
        accountId,
        name: "alchemy_rules_list_adopt",
        kind: "ip",
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
        Effect.catchTag("ListAlreadyExists", () =>
          rules.listLists.items({ accountId }).pipe(
            Stream.filter((l) => l.name === "alchemy_rules_list_adopt"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        ),
      );

    const adopted = yield* stack.deploy(
      Cloudflare.Rules.List("AdoptList", {
        name: "alchemy_rules_list_adopt",
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
);
