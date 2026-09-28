import * as Nuke from "@/Nuke.ts";
import type { ProviderService } from "@/Provider.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect, it } from "alchemy-test";

it.effect("reports each deletion before a slow coordinated pass finishes", () =>
  Effect.gen(function* () {
    const fastDeleted = yield* Deferred.make<void>();
    const events: string[] = [];
    const provider: ProviderService = {
      list: () => Effect.succeed([]),
      reconcile: () => Effect.succeed({}),
      delete: ({ id }) =>
        id === "slow" ? Deferred.await(fastDeleted) : Effect.void,
    };
    const result = yield* Nuke.destroy({
      targets: ["fast", "slow"].map((displayName) => ({
        providerId: "Test.Resource",
        displayName,
        attributes: {},
        provider,
      })),
      context: Context.empty(),
      strategy: { _tag: "coordinated" },
      onPass: (pass) =>
        Effect.sync(() => {
          events.push(`pass ${pass}`);
        }),
      onDeleted: (resource) =>
        Effect.gen(function* () {
          events.push(resource.displayName);
          if (resource.displayName === "fast")
            yield* Deferred.succeed(fastDeleted, undefined);
        }),
    }).pipe(Effect.timeout("2 seconds"));
    expect(result.deleted).toHaveLength(2);
    expect(events).toEqual(["pass 1", "fast", "slow"]);
  }),
);

it.effect("reports scan totals and settles failed providers", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const provider: ProviderService = {
      list: () => Effect.fail(new Error("unavailable")),
      reconcile: () => Effect.succeed({}),
      delete: () => Effect.void,
    };
    const tag = Context.Service<ProviderService>("Test.Resource");
    const result = yield* Nuke.list({
      context: Context.make(tag, provider),
      mode: "live",
      onScan: (total) =>
        Effect.sync(() => {
          events.push(`total ${total}`);
        }),
      onProviderStarted: (id) =>
        Effect.sync(() => {
          events.push(`start ${id}`);
        }),
      onProvider: (id, count) =>
        Effect.sync(() => {
          events.push(`done ${id} ${count}`);
        }),
    });
    expect(result.failures).toHaveLength(1);
    expect(events).toEqual([
      "total 1",
      "start Test.Resource",
      "done Test.Resource 0",
    ]);
  }),
);

it.effect(
  "preserves structured provider errors in scan and deletion reports",
  () =>
    Effect.gen(function* () {
      const error = {
        _tag: "AccessDeniedException",
        message: "This service is unavailable for this account",
        details: { code: 403 },
      };
      const provider: ProviderService = {
        list: () => Effect.fail(error),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.fail(error),
      };
      const context = Context.make(
        Context.Service<ProviderService>("Test.Resource"),
        provider,
      );
      const scan = yield* Nuke.list({ context, mode: "live" });
      const messages = scan.failures.map((failure) => failure.message);
      for (const strategy of [
        { _tag: "coordinated" },
        { _tag: "independent", retries: 0 },
      ] as const) {
        const result = yield* Nuke.destroy({
          targets: [
            {
              providerId: "Test.Resource",
              displayName: "example",
              attributes: {},
              provider,
            },
          ],
          context,
          strategy,
          onFailed: (_resource, message) =>
            Effect.sync(() => {
              messages.push(message);
            }),
        });
        expect(result.failed).toHaveLength(1);
        messages.push(result.failed[0]!.failure.message);
      }
      expect(messages).toHaveLength(5);
      for (const message of messages) {
        expect(message).toContain("AccessDeniedException");
        expect(message).toContain(error.message);
        expect(message).toContain("403");
        expect(message).not.toContain("[object Object]");
        expect(message).not.toContain("no progress");
      }
    }),
);

it.effect("reports scan failures before other providers finish listing", () =>
  Effect.gen(function* () {
    const reported = yield* Deferred.make<void>();
    const failed: ProviderService = {
      list: () =>
        Effect.fail({ _tag: "AccessDenied", message: "denied during scan" }),
      reconcile: () => Effect.succeed({}),
      delete: () => Effect.void,
    };
    const slow: ProviderService = {
      ...failed,
      list: () => Deferred.await(reported).pipe(Effect.as([])),
    };
    const context = Context.make(
      Context.Service<ProviderService>("Test.Failed"),
      failed,
    ).pipe(Context.add(Context.Service<ProviderService>("Test.Slow"), slow));
    const errors: string[] = [];
    const result = yield* Nuke.list({
      context,
      mode: "live",
      onProvider: (provider, count, error) =>
        Effect.gen(function* () {
          if (error === undefined) return;
          expect(provider).toBe("Test.Failed");
          expect(count).toBe(0);
          errors.push(error);
          yield* Deferred.succeed(reported, undefined);
        }),
    }).pipe(Effect.timeout("2 seconds"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("denied during scan");
    expect(result.failures[0]?.message).toBe(errors[0]);
  }),
);
