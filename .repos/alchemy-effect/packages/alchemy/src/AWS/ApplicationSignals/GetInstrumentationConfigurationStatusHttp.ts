import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetInstrumentationConfigurationStatus } from "./GetInstrumentationConfigurationStatus.ts";
import type { InstrumentationConfiguration } from "./InstrumentationConfiguration.ts";

/**
 * Bespoke implementation (not built on the shared scaffolding): the runtime
 * callable injects the bound configuration's full identity — the
 * type/service/environment/signal quadruple plus the location hash —
 * rather than a single identifier field.
 */
export const GetInstrumentationConfigurationStatusHttp = Layer.effect(
  GetInstrumentationConfigurationStatus,
  Effect.gen(function* () {
    const op = yield* appsignals.getInstrumentationConfigurationStatus;
    const tag = "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus";

    return Effect.fn(function* (configuration: InstrumentationConfiguration) {
      const InstrumentationType = yield* configuration.instrumentationType;
      const Service = yield* configuration.service;
      const Environment = yield* configuration.environment;
      const SignalType = yield* configuration.signalType;
      const LocationHash = yield* configuration.locationHash;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${tag}(${configuration}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "application-signals:GetInstrumentationConfigurationStatus",
                ],
                // The dynamic-instrumentation actions do not document
                // resource-level permission support.
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${tag}(${configuration.LogicalId})`)(function* (
        request?: Omit<
          appsignals.GetInstrumentationConfigurationStatusRequest,
          | "InstrumentationType"
          | "Service"
          | "Environment"
          | "SignalType"
          | "LocationIdentifier"
        >,
      ) {
        return yield* op({
          ...request,
          InstrumentationType: yield* InstrumentationType,
          Service: yield* Service,
          Environment: yield* Environment,
          SignalType: yield* SignalType,
          LocationIdentifier: { LocationHash: yield* LocationHash },
        });
      });
    });
  }),
);
