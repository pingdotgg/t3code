import { FraudCheck } from "@bank/domain/Fraud/FraudCheck.external";
import * as Effect from "effect/Effect";

/**
 * A stand-in adapter for a fraud vendor: large withdrawals score as risky.
 * Swap it for an HTTP adapter in production.
 */
export const SiftFraudCheck = FraudCheck.toLayer(
  Effect.succeed({
    score: ({ amount }) => Effect.succeed({ risk: amount >= 80_000 ? 0.95 : 0.05 }),
  }),
);
