import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as turnstile from "@distilled.cloud/cloudflare/turnstile";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName = "alchemy-test-2.us";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getWidget = (accountId: string, sitekey: string) =>
  turnstile.getWidget({ accountId, sitekey }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, sitekey: string) =>
  getWidget(accountId, sitekey).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "WidgetNotDeleted" } as const)),
    // A missing widget surfaces as `WidgetNotFound` (Cloudflare error
    // code 10404) — that's the success condition here.
    Effect.catchTag("WidgetNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WidgetNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete a widget with default name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const widget = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("DefaultWidget", {
        domains: [zoneName],
        mode: "managed",
      }),
    );

    expect(widget.sitekey).toBeDefined();
    expect(Redacted.value(widget.secret)).toBeTruthy();
    expect(widget.accountId).toEqual(accountId);
    expect(widget.domains).toEqual([zoneName]);
    expect(widget.mode).toEqual("managed");
    expect(widget.region).toEqual("world");

    const live = yield* getWidget(accountId, widget.sitekey);
    expect(live.sitekey).toEqual(widget.sitekey);
    expect(live.domains).toEqual([zoneName]);
    expect(live.mode).toEqual("managed");

    yield* stack.destroy();

    yield* expectGone(accountId, widget.sitekey);
  }).pipe(logLevel),
);

test.provider("update mutable props in place (same sitekey)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("UpdateWidget", {
        name: "alchemy-turnstile-update",
        domains: [zoneName],
        mode: "managed",
      }),
    );

    expect(initial.name).toEqual("alchemy-turnstile-update");
    expect(initial.mode).toEqual("managed");

    const updated = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("UpdateWidget", {
        name: "alchemy-turnstile-update-v2",
        domains: [zoneName, `www.${zoneName}`],
        mode: "invisible",
      }),
    );

    // Same widget mutated in place — not a replacement.
    expect(updated.sitekey).toEqual(initial.sitekey);
    expect(updated.name).toEqual("alchemy-turnstile-update-v2");
    expect(updated.mode).toEqual("invisible");
    expect([...updated.domains].sort()).toEqual(
      [zoneName, `www.${zoneName}`].sort(),
    );

    const live = yield* getWidget(accountId, updated.sitekey);
    expect(live.name).toEqual("alchemy-turnstile-update-v2");
    expect(live.mode).toEqual("invisible");
    expect([...live.domains].sort()).toEqual(
      [zoneName, `www.${zoneName}`].sort(),
    );

    // Redeploying identical props is a no-op (still the same widget).
    const noop = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("UpdateWidget", {
        name: "alchemy-turnstile-update-v2",
        domains: [zoneName, `www.${zoneName}`],
        mode: "invisible",
      }),
    );
    expect(noop.sitekey).toEqual(initial.sitekey);

    yield* stack.destroy();

    yield* expectGone(accountId, initial.sitekey);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const widget = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("HealWidget", {
        name: "alchemy-turnstile-heal",
        domains: [zoneName],
        mode: "non-interactive",
      }),
    );

    // Delete the widget out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the widget as missing and recreate it instead of failing on a 404.
    yield* turnstile.deleteWidget({ accountId, sitekey: widget.sitekey }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

    const healed = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("HealWidget", {
        name: "alchemy-turnstile-heal",
        domains: [zoneName],
        mode: "managed",
      }),
    );

    expect(healed.sitekey).not.toEqual(widget.sitekey);
    expect(healed.mode).toEqual("managed");
    const live = yield* getWidget(accountId, healed.sitekey);
    expect(live.name).toEqual("alchemy-turnstile-heal");
    expect(live.mode).toEqual("managed");

    yield* stack.destroy();

    yield* expectGone(accountId, healed.sitekey);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed widget", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const widget = yield* stack.deploy(
      Cloudflare.Turnstile.Widget("ListWidget", {
        name: "alchemy-turnstile-list",
        domains: [zoneName],
        mode: "managed",
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Turnstile.Widget);
    const all = yield* provider.list();

    const found = all.find((w) => w.sitekey === widget.sitekey);
    expect(found).toBeDefined();
    expect(found?.name).toEqual("alchemy-turnstile-list");
    expect(found?.domains).toEqual([zoneName]);
    expect(found?.mode).toEqual("managed");
    // list() hydrates the write-only secret to match the read shape.
    expect(Redacted.value(found!.secret)).toBeTruthy();

    yield* stack.destroy();
  }).pipe(logLevel),
);
