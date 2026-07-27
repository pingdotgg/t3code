import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getList = (accountId: string, listId: string) =>
  zeroTrust.getGatewayList({ accountId, listId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted list surfaces as `GatewayListNotFound` (Cloudflare code 2218).
const expectGone = (accountId: string, listId: string) =>
  getList(accountId, listId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ListNotDeleted" } as const)),
    Effect.catchTag("GatewayListNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ListNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const itemValues = (items: ReadonlyArray<{ value: string }>) =>
  items.map((i) => i.value).sort();

test.provider("create, verify, and destroy a DOMAIN list", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const list = yield* stack.deploy(
      Cloudflare.Gateway.List("BasicList", {
        name: "alchemy-zt-list-basic",
        type: "DOMAIN",
        description: "alchemy test list",
        items: [
          { value: "a.alchemy-test.example" },
          { value: "b.alchemy-test.example" },
        ],
      }),
    );

    expect(list.listId).toBeTruthy();
    expect(list.accountId).toEqual(accountId);
    expect(list.type).toEqual("DOMAIN");
    expect(itemValues(list.items)).toEqual([
      "a.alchemy-test.example",
      "b.alchemy-test.example",
    ]);

    const live = yield* getList(accountId, list.listId);
    expect(live.name).toEqual("alchemy-zt-list-basic");
    expect(live.description).toEqual("alchemy test list");
    expect(itemValues((live.items ?? []) as { value: string }[])).toEqual([
      "a.alchemy-test.example",
      "b.alchemy-test.example",
    ]);

    yield* stack.destroy();
    yield* expectGone(accountId, list.listId);
  }).pipe(logLevel),
);

test.provider("update items, description, and name in place", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Gateway.List("UpdateList", {
        name: "alchemy-zt-list-update",
        type: "DOMAIN",
        items: [
          { value: "keep.alchemy-test.example" },
          { value: "remove.alchemy-test.example" },
        ],
      }),
    );

    const updated = yield* stack.deploy(
      Cloudflare.Gateway.List("UpdateList", {
        name: "alchemy-zt-list-update-v2",
        type: "DOMAIN",
        description: "now with a description",
        items: [
          { value: "keep.alchemy-test.example" },
          { value: "add.alchemy-test.example" },
        ],
      }),
    );

    // Same list mutated in place — not a replacement.
    expect(updated.listId).toEqual(initial.listId);
    expect(updated.name).toEqual("alchemy-zt-list-update-v2");
    expect(itemValues(updated.items)).toEqual([
      "add.alchemy-test.example",
      "keep.alchemy-test.example",
    ]);

    const live = yield* getList(accountId, updated.listId);
    expect(live.name).toEqual("alchemy-zt-list-update-v2");
    expect(live.description).toEqual("now with a description");
    expect(itemValues((live.items ?? []) as { value: string }[])).toEqual([
      "add.alchemy-test.example",
      "keep.alchemy-test.example",
    ]);

    // Redeploying identical props is a no-op (still the same list).
    const noop = yield* stack.deploy(
      Cloudflare.Gateway.List("UpdateList", {
        name: "alchemy-zt-list-update-v2",
        type: "DOMAIN",
        description: "now with a description",
        items: [
          { value: "keep.alchemy-test.example" },
          { value: "add.alchemy-test.example" },
        ],
      }),
    );
    expect(noop.listId).toEqual(initial.listId);

    yield* stack.destroy();
    yield* expectGone(accountId, initial.listId);
  }).pipe(logLevel),
);

test.provider("changing the type replaces the list", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const domainList = yield* stack.deploy(
      Cloudflare.Gateway.List("ReplaceList", {
        name: "alchemy-zt-list-replace",
        type: "DOMAIN",
        items: [{ value: "x.alchemy-test.example" }],
      }),
    );

    // The name is the resource's cold-read identity, so a replacement
    // (type change) pairs with a rename — keeping the old name would make
    // the engine find the doomed sibling and refuse to adopt it.
    const ipList = yield* stack.deploy(
      Cloudflare.Gateway.List("ReplaceList", {
        name: "alchemy-zt-list-replace-ip",
        type: "IP",
        items: [{ value: "203.0.113.1" }],
      }),
    );

    // Type is immutable — the engine must have created a new list.
    expect(ipList.listId).not.toEqual(domainList.listId);
    expect(ipList.type).toEqual("IP");

    const live = yield* getList(accountId, ipList.listId);
    expect(live.type).toEqual("IP");
    // The old list was deleted by the replacement.
    yield* expectGone(accountId, domainList.listId);

    yield* stack.destroy();
    yield* expectGone(accountId, ipList.listId);
  }).pipe(logLevel),
);
