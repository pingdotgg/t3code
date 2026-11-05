import { expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { onEvent } from "@/Events.ts";
import * as Nuke from "@/Nuke.ts";
import type { ProviderService } from "@/Provider.ts";

it.effect(
  "reports each deletion before a slow coordinated pass finishes",
  () =>
    Effect.gen(function* () {
      const fastDeleted = yield* Deferred.make<void>();
      const events: string[] = [];
      const provider: ProviderService = {
        list: () => Effect.succeed([]),
        reconcile: () => Effect.succeed({}),
        delete: ({ id }) => (id === "slow" ? Deferred.await(fastDeleted) : Effect.void),
      };
      const result = yield* Nuke.destroy({
        targets: ["fast", "slow"].map((displayName) => ({
          key: "t101",
          providerId: "Test.Resource",
          displayName,
          attributes: {},
          provider,
        })),
        context: Context.empty(),
        strategy: { type: "coordinated" },
      }).pipe(
        onEvent((event) =>
          Effect.gen(function* () {
            if (event.type === "nuke.pass.started") events.push(`pass ${event.pass}`);
            if (event.type !== "nuke.resource.deleted") return;
            events.push(event.resource);
            if (event.resource === "fast") yield* Deferred.succeed(fastDeleted, undefined);
          }),
        ),
        Effect.timeout("2 seconds"),
      );
      expect(result.deleted).toHaveLength(2);
      expect(events).toEqual(["pass 1", "fast", "slow"]);
    }),
  { tags: ["unit", "local"] },
);

it.effect(
  "reports scan totals and settles failed providers",
  () =>
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
      }).pipe(
        onEvent((event) =>
          Effect.sync(() => {
            if (event.type === "nuke.scan.started") events.push(`total ${event.total}`);
            if (event.type === "nuke.scan.provider.started") events.push(`start ${event.provider}`);
            if (event.type === "nuke.scan.provider.completed")
              events.push(`done ${event.provider} ${event.resources}`);
          }),
        ),
      );
      expect(result.failures).toHaveLength(1);
      expect(events).toEqual(["total 1", "start Test.Resource", "done Test.Resource 0"]);
    }),
  { tags: ["unit", "local"] },
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
      const context = Context.make(Context.Service<ProviderService>("Test.Resource"), provider);
      const scan = yield* Nuke.list({ context, mode: "live" });
      const messages = scan.failures.map((failure) => failure.message);
      for (const strategy of [
        { type: "coordinated" },
        { type: "independent", retries: 0 },
      ] as const) {
        const result = yield* Nuke.destroy({
          targets: [
            {
              key: "t1",
              providerId: "Test.Resource",
              displayName: "example",
              attributes: {},
              provider,
            },
          ],
          context,
          strategy,
        }).pipe(
          onEvent((event) =>
            Effect.sync(() => {
              if (event.type === "nuke.resource.failed") messages.push(event.message);
            }),
          ),
        );
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
  { tags: ["unit", "local"] },
);

it.effect(
  "reports scan failures before other providers finish listing",
  () =>
    Effect.gen(function* () {
      const reported = yield* Deferred.make<void>();
      const failed: ProviderService = {
        list: () => Effect.fail({ _tag: "AccessDenied", message: "denied during scan" }),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.void,
      };
      const slow: ProviderService = {
        ...failed,
        list: () => Deferred.await(reported).pipe(Effect.as([])),
      };
      const context = Context.make(Context.Service<ProviderService>("Test.Failed"), failed).pipe(
        Context.add(Context.Service<ProviderService>("Test.Slow"), slow),
      );
      const errors: string[] = [];
      const result = yield* Nuke.list({
        context,
        mode: "live",
      }).pipe(
        onEvent((event) =>
          Effect.gen(function* () {
            if (event.type !== "nuke.scan.provider.completed" || event.error === undefined) return;
            expect(event.provider).toBe("Test.Failed");
            expect(event.resources).toBe(0);
            errors.push(event.error);
            yield* Deferred.succeed(reported, undefined);
          }),
        ),
        Effect.timeout("2 seconds"),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("denied during scan");
      expect(result.failures[0]?.message).toBe(errors[0]);
    }),
  { tags: ["unit", "local"] },
);

it.effect(
  "settles a provider that dies, like a rejected credential layer",
  () =>
    Effect.gen(function* () {
      const provider: ProviderService = {
        list: () => Effect.die({ _tag: "RailwayForbidden", message: "Not Authorized" }),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.die({ _tag: "RailwayForbidden", message: "Not Authorized" }),
      };
      const healthy: ProviderService = {
        list: () => Effect.succeed([{ name: "kept" }]),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.void,
      };
      const context = Context.make(Context.Service<ProviderService>("Test.Dies"), provider).pipe(
        Context.add(Context.Service<ProviderService>("Test.Healthy"), healthy),
      );
      const scan = yield* Nuke.list({ context, mode: "live" });
      expect(scan.resources.map((resource) => resource.providerId)).toEqual(["Test.Healthy"]);
      expect(scan.failures.map((failure) => failure.provider)).toEqual(["Test.Dies"]);
      expect(scan.failures[0]?.message).toContain("Not Authorized");
      for (const strategy of [
        { type: "coordinated" },
        { type: "independent", retries: 0 },
      ] as const) {
        const result = yield* Nuke.destroy({
          targets: [
            { key: "t1", providerId: "Test.Dies", displayName: "x", attributes: {}, provider },
          ],
          context,
          strategy,
        });
        expect(result.failed[0]?.failure.message).toContain("Not Authorized");
      }
    }),
  { tags: ["unit", "local"] },
);
