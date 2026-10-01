import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";
import type { EmailTemplate } from "./EmailTemplate.ts";

/**
 * Shared scaffolding for Amazon SES v2 HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and the
 * injected identifier is boilerplate.
 */

/**
 * Build the impl Effect for an account-level SES operation (account status,
 * account suppression list). These IAM actions do not support resource-level
 * permissions, so the deploy-time half grants `actions` on `*` and the
 * runtime callable passes the caller's request through as-is.
 */
export const makeSESHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SES.GetAccount`. */
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
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for a template-scoped SES operation. The runtime
 * callable injects the bound {@link EmailTemplate}'s name as the request's
 * `TemplateName`; the deploy-time half grants `actions` on the template ARN.
 */
export const makeTemplateScopedHttpBinding = <
  I extends { TemplateName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SES.RenderEmailTemplate`. */
  tag: string;
  /** The distilled operation; `TemplateName` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the template ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (template: EmailTemplate) {
      const TemplateName = yield* template.templateName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${template}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [template.templateArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${template.LogicalId})`)(function* (
        request: Omit<I, "TemplateName">,
      ) {
        return yield* op({
          ...request,
          TemplateName: yield* TemplateName,
        } as I);
      });
    });
  });

/**
 * An SES identity referenced by address or domain, used ONLY to scope an IAM
 * grant.
 *
 * Unlike passing an {@link EmailIdentity} resource this creates no resource
 * edge and no ownership: nothing is created, adopted, or destroyed. That
 * matters when the identity is managed outside the stack — binding to a
 * resource would mean owning it, and owning it would mean `destroy` deleting
 * it.
 */
export interface EmailIdentityRef {
  /** The verified email address or domain, e.g. `"sender@example.com"`. */
  emailIdentity: string;
}

// Discriminate on the REF side: a resource's `emailIdentity` is an Output, not
// a string. Testing for a resource key with `in` does not work — the resource
// is an Output proxy, so every property "exists".
const isEmailIdentityRef = (
  identity: EmailIdentity | EmailIdentityRef,
): identity is EmailIdentityRef =>
  typeof (identity as EmailIdentityRef).emailIdentity === "string";

/**
 * Build the impl Effect for `SendCustomVerificationEmail`, scoped to the
 * identity being VERIFIED.
 *
 * Unlike the send bindings, SES authorizes this action against the identity
 * of the address in the request — the recipient the verification email starts
 * verification for — not against the template's FROM identity. Confirmed
 * live: a policy granting only the sender identity is refused with
 * "not authorized to perform: ses:SendCustomVerificationEmail on resource:
 * arn:aws:ses:<region>:<account>:identity/<RECIPIENT>".
 *
 * So the bound identity names what the function is allowed to verify: a
 * single address, or a domain, in which case addresses at that domain are
 * covered. That is the constraint worth enforcing — it stops a leaked binding
 * being used to send verification mail to arbitrary addresses.
 *
 * Accepts a managed {@link EmailIdentity} or an {@link EmailIdentityRef}; the
 * reference form derives the ARNs from the ambient account and region without
 * taking ownership. An optional {@link ConfigurationSet} is injected into the
 * request and added to the grant.
 */
export const makeVerificationScopedHttpBinding = <
  I extends { ConfigurationSetName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SES.SendCustomVerificationEmail`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the identity/address/template ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      identity: EmailIdentity | EmailIdentityRef,
      configurationSet?: ConfigurationSet,
    ) {
      const ConfigurationSetName = configurationSet
        ? yield* configurationSet.configurationSetName
        : undefined;
      const label = isEmailIdentityRef(identity)
        ? identity.emailIdentity
        : identity.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // Authorize the identity being verified: the address itself, or
          // every address at the domain when a domain is bound. The account's
          // custom verification email templates are granted alongside, since
          // the request also names one.
          const resources: Input<string>[] = [];
          if (isEmailIdentityRef(identity)) {
            const { accountId, region } =
              yield* AWSEnvironment.current as unknown as Effect.Effect<{
                accountId: string;
                region: string;
              }>;
            const base = `arn:aws:ses:${region}:${accountId}`;
            const name = identity.emailIdentity;
            resources.push(
              `${base}:identity/${name}`,
              // A domain reference also authorizes addresses at that domain.
              name.includes("@")
                ? `${base}:identity/${name}`
                : `${base}:identity/*@${name}`,
              `${base}:custom-verification-email-template/*`,
            );
          } else {
            resources.push(
              identity.identityArn,
              Output.all(identity.identityArn).pipe(
                Output.map(([identityArn]) =>
                  identityArn.includes("@")
                    ? identityArn
                    : identityArn.replace(/:identity\//, ":identity/*@"),
                ),
              ),
              Output.all(identity.identityArn).pipe(
                Output.map(([identityArn]) =>
                  identityArn.replace(
                    /:identity\/.*$/,
                    ":custom-verification-email-template/*",
                  ),
                ),
              ),
            );
          }
          if (configurationSet) {
            resources.push(configurationSet.configurationSetArn);
          }
          yield* host.bind`Allow(${host}, ${options.tag}(${label}, ${configurationSet ?? "none"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: resources,
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${label})`)(function* (
        request: Omit<I, "ConfigurationSetName">,
      ) {
        const configurationSetName = ConfigurationSetName
          ? yield* ConfigurationSetName
          : undefined;
        return yield* op({
          ...request,
          ConfigurationSetName: configurationSetName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an identity-scoped send operation (`SendEmail`,
 * `SendBulkEmail`). The binding resolves the bound {@link EmailIdentity}
 * (and optional {@link ConfigurationSet}) and:
 *
 * - grants `actions` on the identity ARN, on addresses at the identity's
 *   domain (SES authorizes a send against the identity of the FROM address,
 *   not the domain identity ARN), on the account's templates (templated
 *   sends are authorized against the template resource), and on the
 *   configuration set ARN when one is bound;
 * - at runtime defaults `FromEmailAddress` to the identity and injects the
 *   bound configuration set's name.
 */
export const makeSendScopedHttpBinding = <
  I extends { FromEmailAddress?: string; ConfigurationSetName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SES.SendEmail`. */
  tag: string;
  /** The distilled send operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the identity/address/template/config-set ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <Identity extends EmailIdentity>(
      identity: Identity,
      configurationSet?: ConfigurationSet,
    ) {
      const FromIdentity = yield* identity.emailIdentity;
      const ConfigurationSetName = configurationSet
        ? yield* configurationSet.configurationSetName
        : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // Templated sends are authorized against the template resource, so
          // grant the account's templates alongside the bound identity.
          const templateArns = Output.all(identity.identityArn).pipe(
            Output.map(([identityArn]) =>
              identityArn.replace(/:identity\/.*$/, ":template/*"),
            ),
          );
          // For a domain identity, SES authorizes the send against the
          // identity ARN of the FROM address (identity/user@domain), not the
          // domain identity ARN — grant addresses at the domain too.
          const addressArns = Output.all(identity.identityArn).pipe(
            Output.map(([identityArn]) =>
              identityArn.includes("@")
                ? identityArn
                : identityArn.replace(/:identity\//, ":identity/*@"),
            ),
          );
          yield* host.bind`Allow(${host}, ${options.tag}(${identity}, ${configurationSet ?? "none"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [
                    identity.identityArn,
                    addressArns,
                    templateArns,
                    ...(configurationSet
                      ? [configurationSet.configurationSetArn]
                      : []),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${identity.LogicalId})`)(function* (
        request: Omit<I, "ConfigurationSetName">,
      ) {
        const fromIdentity = yield* FromIdentity;
        const configurationSetName = ConfigurationSetName
          ? yield* ConfigurationSetName
          : undefined;
        return yield* op({
          ...request,
          FromEmailAddress: (request as I).FromEmailAddress ?? fromIdentity,
          ConfigurationSetName: configurationSetName,
        } as I);
      });
    });
  });
