import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import type { ProviderServiceError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  evaluateHandoverStartLimits,
  evaluateTurnStartLimits,
  type UsageLimitViolation,
} from "./ConcurrentTurnPolicy.ts";

type Reservation =
  | { readonly kind: "turn"; readonly threadId: ThreadId }
  | { readonly kind: "handover"; readonly threadId: ThreadId };

export class UsageLimitReservations extends Context.Service<
  UsageLimitReservations,
  {
    readonly reserveTurn: (input: {
      readonly key: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<UsageLimitViolation | undefined, ProviderServiceError>;
    readonly reserveHandover: (input: {
      readonly key: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<UsageLimitViolation | undefined, ProviderServiceError>;
    readonly release: (key: string) => Effect.Effect<void>;
  }
>()("t3/orchestration/UsageLimitReservations") {}

export const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const reservations = new Map<string, Reservation>();

  const release: UsageLimitReservations["Service"]["release"] = (key) =>
    Effect.sync(() => {
      reservations.delete(key);
    });

  const reserveTurn: UsageLimitReservations["Service"]["reserveTurn"] = Effect.fn(
    "UsageLimitReservations.reserveTurn",
  )(function* (input: Parameters<UsageLimitReservations["Service"]["reserveTurn"]>[0]) {
    const sessions = yield* providerService.listSessions();
    return yield* Effect.sync(() => {
      const values = [...reservations.values()];
      const violation = evaluateTurnStartLimits({
        threadId: input.threadId,
        sessions,
        reservedTurnThreadIds: values
          .filter((reservation) => reservation.kind === "turn")
          .map((reservation) => reservation.threadId),
        reservedHandoverCount: values.filter((reservation) => reservation.kind === "handover")
          .length,
      });
      if (violation) return violation;

      reservations.set(input.key, { kind: "turn", threadId: input.threadId });
      return undefined;
    });
  });

  const reserveHandover: UsageLimitReservations["Service"]["reserveHandover"] = Effect.fn(
    "UsageLimitReservations.reserveHandover",
  )(function* (input: Parameters<UsageLimitReservations["Service"]["reserveHandover"]>[0]) {
    const sessions = yield* providerService.listSessions();
    return yield* Effect.sync(() => {
      const values = [...reservations.values()];
      if (
        values.some(
          (reservation) =>
            reservation.kind === "handover" && reservation.threadId === input.threadId,
        )
      ) {
        return {
          code: "handover-in-progress",
          detail: "A handover is already being generated for this thread.",
        } satisfies UsageLimitViolation;
      }

      const violation = evaluateHandoverStartLimits({
        sessions,
        reservedTurnThreadIds: values
          .filter((reservation) => reservation.kind === "turn")
          .map((reservation) => reservation.threadId),
        reservedHandoverCount: values.filter((reservation) => reservation.kind === "handover")
          .length,
      });
      if (violation) return violation;

      reservations.set(input.key, { kind: "handover", threadId: input.threadId });
      return undefined;
    });
  });

  return UsageLimitReservations.of({ reserveTurn, reserveHandover, release });
});

export const layer = Layer.effect(UsageLimitReservations, make);
