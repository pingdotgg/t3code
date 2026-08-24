import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GenerateMacEmvPinChange,
  type GenerateMacEmvPinChangeRequest,
} from "./GenerateMacEmvPinChange.ts";
import type { Key } from "./Key.ts";

/**
 * HTTP implementation of {@link GenerateMacEmvPinChange} — bespoke (not
 * scaffolded): the operation spans three keys (the new PIN PEK plus the
 * secure-messaging integrity and confidentiality keys). Grants the host
 * Function `payment-cryptography:GenerateMacEmvPinChange` on all three key
 * ARNs and injects each identifier at runtime.
 */
export const GenerateMacEmvPinChangeHttp = Layer.effect(
  GenerateMacEmvPinChange,
  Effect.gen(function* () {
    const generateMacEmvPinChange =
      yield* paymentcryptographydata.generateMacEmvPinChange;

    return Effect.fn(function* <P extends Key, I extends Key, C extends Key>(
      newPinPek: P,
      secureMessagingIntegrityKey: I,
      secureMessagingConfidentialityKey: C,
    ) {
      const NewPinPekArn = yield* newPinPek.keyArn;
      const IntegrityKeyArn = yield* secureMessagingIntegrityKey.keyArn;
      const ConfidentialityKeyArn =
        yield* secureMessagingConfidentialityKey.keyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          for (const key of [
            newPinPek,
            secureMessagingIntegrityKey,
            secureMessagingConfidentialityKey,
          ]) {
            yield* host.bind`Allow(${host}, AWS.PaymentCryptography.GenerateMacEmvPinChange(${key}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: ["payment-cryptography:GenerateMacEmvPinChange"],
                    Resource: [key.keyArn],
                  },
                ],
              },
            );
          }
        }
      }
      return Effect.fn(
        `AWS.PaymentCryptography.GenerateMacEmvPinChange(${newPinPek.LogicalId})`,
      )(function* (request: GenerateMacEmvPinChangeRequest) {
        return yield* generateMacEmvPinChange({
          ...request,
          NewPinPekIdentifier: yield* NewPinPekArn,
          SecureMessagingIntegrityKeyIdentifier: yield* IntegrityKeyArn,
          SecureMessagingConfidentialityKeyIdentifier:
            yield* ConfidentialityKeyArn,
        });
      });
    });
  }),
);
