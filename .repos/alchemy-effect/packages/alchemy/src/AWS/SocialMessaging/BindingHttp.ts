import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Shared scaffolding for AWS End User Messaging Social (WhatsApp) HTTP
 * bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service
 * is a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: WABA-scoped bindings inject the bound linked account's
 * `id` (`waba-…`) into every request and grant `actions` on the WABA ARN;
 * phone-plane bindings pass the request through (the caller addresses a
 * phone number by its `phone-number-id-…`) and grant `actions` on `*`,
 * because the WABA's phone numbers are provisioned by Meta at onboarding
 * time and their ARNs are not derivable from the WABA ARN at bind time.
 */

/**
 * Build the impl Effect for an operation scoped to the bound
 * {@link LinkedWhatsAppBusinessAccount} (message templates, WhatsApp
 * Flows): the deploy-time half grants `actions` on the WABA ARN and the
 * runtime half injects the linked account id into every request as `id`.
 */
export const makeWabaScopedHttpBinding = <
  I extends { id: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SocialMessaging.ListWhatsAppMessageTemplates`. */
  tag: string;
  /** The distilled operation; `id` is injected from the linked account. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the WABA ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (account: LinkedWhatsAppBusinessAccount) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const AccountId = yield* account.id;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${account}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [account.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "id">,
      ) {
        return yield* op({ ...request, id: yield* AccountId } as I);
      });
    });
  });

/**
 * Build the impl Effect for a phone-number-plane operation
 * (`SendWhatsAppMessage`, message media): the caller addresses one of the
 * bound WABA's phone numbers per request (`originationPhoneNumberId` /
 * `id`), so the request passes through unchanged. The deploy-time half
 * grants `actions` on `*` — phone numbers are provisioned by Meta under
 * the WABA and their ARNs are not derivable from the WABA ARN.
 */
export const makeWabaPhonePlaneHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SocialMessaging.SendWhatsAppMessage`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (account: LinkedWhatsAppBusinessAccount) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${account}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
