import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
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
