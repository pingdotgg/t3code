import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Key } from "./Key.ts";
import {
  TranslateKeyMaterial,
  type TranslateKeyMaterialRequest,
} from "./TranslateKeyMaterial.ts";

/**
 * HTTP implementation of {@link TranslateKeyMaterial} — bespoke (not
 * scaffolded): the key identifiers live in nested request structures
 * (`IncomingKeyMaterial.DiffieHellmanTr31KeyBlock.PrivateKeyIdentifier`,
 * `OutgoingKeyMaterial.Tr31KeyBlock.WrappingKeyIdentifier`) whose union arms
 * vary by exchange scheme, so nothing is injected. The deploy-time half
 * grants `payment-cryptography:TranslateKeyMaterial` on every bound
 * {@link Key}; the caller supplies the full request (resolving each key's
 * ARN itself).
 */
export const TranslateKeyMaterialHttp = Layer.effect(
  TranslateKeyMaterial,
  Effect.gen(function* () {
    const translateKeyMaterial =
      yield* paymentcryptographydata.translateKeyMaterial;

    return Effect.fn(function* (...keys: readonly [Key, ...Key[]]) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          for (const key of keys) {
            yield* host.bind`Allow(${host}, AWS.PaymentCryptography.TranslateKeyMaterial(${key}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: ["payment-cryptography:TranslateKeyMaterial"],
                    Resource: [key.keyArn],
                  },
                ],
              },
            );
          }
        }
      }
      return Effect.fn(
        `AWS.PaymentCryptography.TranslateKeyMaterial(${keys
          .map((key) => key.LogicalId)
          .join(", ")})`,
      )(function* (request: TranslateKeyMaterialRequest) {
        return yield* translateKeyMaterial(request);
      });
    });
  }),
);
