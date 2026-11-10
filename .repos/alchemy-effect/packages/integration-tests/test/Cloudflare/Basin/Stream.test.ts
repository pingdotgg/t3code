import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schema from "effect/Schema";
import { PageView, pageViewFields } from "./fixtures/pipelines-shared.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getStream = (accountId: string, streamId: string) =>
  pipelines.getStream({ accountId, streamId });

const tags = ["provider:cloudflare", "provider:cloudflare:pipelines", "live"];

test.provider(
  "http defaults to disabled and is applied in place to a public stream",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      // The pre-upgrade shape: a public, unauthenticated endpoint.
      const open = yield* stack.deploy(
        Cloudflare.Basin.Stream("Stream", { http: { enabled: true } }),
      );
      expect(open.httpEnabled).toBe(true);
      expect(open.httpAuthentication).toBe(false);

      // Dropping `http` closes the endpoint — an in-place update.
      const plan = yield* stack.plan(Cloudflare.Basin.Stream("Stream", {}));
      expect(plan.resources.Stream!.action).toEqual("update");

      const closed = yield* stack.deploy(Cloudflare.Basin.Stream("Stream", {}));
      expect(closed.streamId).toEqual(open.streamId);
      expect(closed.httpEnabled).toBe(false);
      const live = yield* getStream(accountId, closed.streamId);
      expect(live.http.enabled).toBe(false);

      // Converged — re-planning the same props is a no-op.
      const again = yield* stack.plan(Cloudflare.Basin.Stream("Stream", {}));
      expect(again.resources.Stream!.action).toEqual("noop");

      // `http: true` re-enables the endpoint with authentication.
      const authed = yield* stack.deploy(Cloudflare.Basin.Stream("Stream", { http: true }));
      expect(authed.streamId).toEqual(open.streamId);
      const liveAuthed = yield* getStream(accountId, authed.streamId);
      expect(liveAuthed.http.enabled).toBe(true);
      expect(liveAuthed.http.authentication).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 180_000 },
);

test.provider(
  "list/struct schema; field list ⇄ Effect Schema is a no-op",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.Basin.Stream("Typed", { schema: { fields: pageViewFields } }),
      );
      const live = yield* getStream(accountId, initial.streamId);
      expect(live.schema?.fields?.map((f) => [f.name, f.type])).toEqual([
        ["url", "string"],
        ["at", "timestamp"],
        ["tags", "list"],
        ["user", "struct"],
      ]);

      // The equivalent Effect Schema derives the same field list.
      const plan = yield* stack.plan(Cloudflare.Basin.Stream("Typed", { schema: PageView }));
      expect(plan.resources.Typed!.action).toEqual("noop");

      const switched = yield* stack.deploy(Cloudflare.Basin.Stream("Typed", { schema: PageView }));
      expect(switched.streamId).toEqual(initial.streamId);

      // A real schema change still replaces.
      const changed = yield* stack.plan(
        Cloudflare.Basin.Stream("Typed", {
          schema: Schema.Struct({ url: Schema.String }),
        }),
      );
      expect(changed.resources.Typed!.action).toEqual("replace");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 180_000 },
);

test.provider(
  "an Effect Schema with no stream representation fails before planning",
  (stack) =>
    Effect.gen(function* () {
      const exit = yield* stack
        .plan(
          Cloudflare.Basin.Stream("Bad", {
            schema: Schema.Struct({ value: Schema.Union([Schema.String, Schema.Number]) }),
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
        "field 'value' is a union of different types",
      );
    }).pipe(logLevel),
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:pipelines", "local"],
    timeout: 60_000,
  },
);
