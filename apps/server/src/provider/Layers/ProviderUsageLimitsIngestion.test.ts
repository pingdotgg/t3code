import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageLimitsIngestionLive } from "./ProviderUsageLimitsIngestion.ts";

it.effect("refreshes the rate-limited provider instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_work");
      const refreshed = yield* Deferred.make<void>();
      const instance = {
        instanceId,
        snapshot: {
          refresh: Deferred.succeed(refreshed, undefined).pipe(Effect.as({} as ServerProvider)),
        },
      } as ProviderInstance;
      const event = {
        type: "runtime.error",
        eventId: EventId.make("event-rate-limit"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-09-04T00:00:00.000Z",
        payload: { message: "Usage limit reached", class: "rate_limit" },
      } satisfies ProviderRuntimeEvent;

      yield* Layer.build(
        ProviderUsageLimitsIngestionLive.pipe(
          Layer.provide(
            Layer.succeed(ProviderInstanceRegistry, {
              getInstance: () => Effect.succeed(instance),
            } as unknown as ProviderInstanceRegistry["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ProviderService, {
              streamEvents: Stream.make(event),
            } as ProviderService["Service"]),
          ),
        ),
      );

      yield* Deferred.await(refreshed);
    }),
  ),
);
