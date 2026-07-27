import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Region } from "../Region.ts";
import type { EmailContact } from "./EmailContact.ts";

/**
 * Shared scaffolding for the AWS User Notifications Contacts HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeEmailContactHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * User Notifications Contacts is a global service managed from a single
 * control-plane region (`us-east-1`) — like its sibling `notifications`
 * service — so every operation is resolved with the Region pinned.
 */
const US_EAST_1 = "us-east-1";
const pinContactsRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(US_EAST_1)));

/**
 * Build the impl Effect for a User Notifications Contacts operation scoped
 * to one {@link EmailContact}: the deploy-time half grants `actions` on the
 * bound contact's ARN, and the runtime half injects the contact's ARN as
 * the `arn` of every request.
 */
export const makeEmailContactHttpBinding = <
  I extends { arn: string },
  A,
  E,
  R,
  Req = Omit<I, "arn">,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NotificationsContacts.SendActivationCode`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the email contact ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* pinContactsRegion(options.operation);

    return Effect.fn(function* (contact: EmailContact) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const ContactArn = yield* contact.emailContactArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${contact}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [contact.emailContactArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${contact.LogicalId})`)(function* (
        request?: Req,
      ) {
        const arn = yield* ContactArn;
        return yield* op({ ...(request as object), arn } as I);
      });
    });
  });
