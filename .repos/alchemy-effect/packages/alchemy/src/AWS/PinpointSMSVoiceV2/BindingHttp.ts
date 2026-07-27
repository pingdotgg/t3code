import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { OptOutList } from "./OptOutList.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * Shared scaffolding for AWS End User Messaging SMS (Pinpoint SMS Voice
 * v2) HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service
 * is a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation and the IAM action list
 * is boilerplate: phone-number-scoped bindings inject the bound number's
 * ARN as the request's `OriginationIdentity` and grant `actions` on that
 * ARN; opt-out-list-scoped bindings inject the list's ARN as
 * `OptOutListName`; account-scoped bindings pass the request through and
 * grant `actions` on `*`.
 */

/**
 * Build the impl Effect for an End User Messaging SMS operation scoped to
 * a {@link PhoneNumber} (`SendTextMessage`, `PutKeyword`, …): the
 * deploy-time half grants `actions` on the bound number's ARN, and the
 * runtime half injects the number's ARN into every request as
 * `OriginationIdentity` (the API accepts a phone number ID or ARN there).
 */
export const makeSmsVoicePhoneNumberHttpBinding = <
  // Optional so the builder accepts SendTextMessage, whose wire
  // `OriginationIdentity` is optional (account-default routing); the
  // binding always injects the bound number's ARN regardless.
  I extends { OriginationIdentity?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.PinpointSMSVoiceV2.SendTextMessage`. */
  tag: string;
  /** The distilled operation; `OriginationIdentity` is injected from the number. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the phone number ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (phoneNumber: PhoneNumber) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const PhoneNumberArn = yield* phoneNumber.phoneNumberArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${phoneNumber}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [phoneNumber.phoneNumberArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${phoneNumber.LogicalId})`)(function* (
        request?: Omit<I, "OriginationIdentity">,
      ) {
        const originationIdentity = yield* PhoneNumberArn;
        return yield* op({
          ...request,
          OriginationIdentity: originationIdentity,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an End User Messaging SMS operation scoped to
 * an {@link OptOutList} (`PutOptedOutNumber`, `DescribeOptedOutNumbers`,
 * …): the deploy-time half grants `actions` on the bound list's ARN, and
 * the runtime half injects the list's ARN into every request as
 * `OptOutListName` (the API accepts a list name or ARN there).
 */
export const makeSmsVoiceOptOutListHttpBinding = <
  I extends { OptOutListName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.PinpointSMSVoiceV2.PutOptedOutNumber`. */
  tag: string;
  /** The distilled operation; `OptOutListName` is injected from the list. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the opt-out list ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (optOutList: OptOutList) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const OptOutListArn = yield* optOutList.optOutListArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${optOutList}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [optOutList.optOutListArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${optOutList.LogicalId})`)(function* (
        request?: Omit<I, "OptOutListName">,
      ) {
        const optOutListName = yield* OptOutListArn;
        return yield* op({ ...request, OptOutListName: optOutListName } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level End User Messaging SMS
 * operation (`CarrierLookup`, `PutMessageFeedback`): the deploy-time half
 * grants `actions` on `*` — these operations act on message IDs or raw
 * phone numbers, not on a scopeable resource ARN.
 */
export const makeSmsVoiceAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.PinpointSMSVoiceV2.CarrierLookup`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
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
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
