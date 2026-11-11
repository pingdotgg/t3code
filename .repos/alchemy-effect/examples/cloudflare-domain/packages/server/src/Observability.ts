import * as Axiom from "@alchemy.run/axiom";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * The stage, the same in both phases: the Stack's at deploy, and the value
 * bound onto the Worker at runtime. Datasets are named after it, so every
 * stage (and every developer's) gets its own.
 */
const stage = Effect.gen(function* () {
  const stack = yield* Effect.serviceOption(Stack);
  if (Option.isSome(stack)) return stack.value.stage;
  return yield* Config.String("ALCHEMY_STAGE").pipe(Effect.orElseSucceed(() => "dev"));
});

/**
 * The bank's telemetry in Axiom: a traces and a logs dataset, and an ingest
 * token that may only write to them. The Worker exports its own spans and
 * logs here, and relays the app's spans here too, with this token, so it
 * never reaches a browser.
 */
export const Observability = Layer.unwrap(
  Effect.gen(function* () {
    const name = `bank-${(yield* stage).replace(/_/g, "-")}`;
    const traces = yield* Axiom.Dataset("Traces", {
      name: `${name}-traces`,
      kind: "otel:traces:v1",
    });
    const logs = yield* Axiom.Dataset("Logs", { name: `${name}-logs`, kind: "otel:logs:v1" });
    const ingest = yield* Axiom.ApiToken("Ingest", {
      name: `${name}-ingest`,
      datasetCapabilities: {
        [`${name}-traces`]: { ingest: ["create"] },
        [`${name}-logs`]: { ingest: ["create"] },
      },
    });
    return Axiom.Telemetry({ token: ingest, traces, logs, serviceName: "bank" });
  }),
);
