import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { SigningProfile } from "./SigningProfile.ts";

/**
 * Shared scaffolding for the AWS Signer HTTP runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * Signer authorizes profile-addressed actions against the *signing profile*
 * ARN (`arn:…:/signing-profiles/name`) and its version-qualified variant
 * (`arn:…:/signing-profiles/name/version`), so the profile-scoped builder
 * grants on both. Job-addressed actions (describe/list/revoke a signing job)
 * target job ids chosen per request at runtime, so those bindings are
 * account-level and grant on `Resource: ["*"]`.
 */
const profilePolicyStatement = (
  profile: SigningProfile,
  actions: readonly string[],
) => ({
  Effect: "Allow" as const,
  Action: [...actions],
  Resource: [
    Output.interpolate`${profile.arn}`,
    // The version-qualified profile ARN (`…/signing-profiles/name/version`).
    Output.map(profile.arn, (arn) => `${arn}/*`),
  ],
});

/**
 * Build the impl Effect for an operation whose input carries a `profileName`
 * field: the runtime callable injects the bound {@link SigningProfile}'s name
 * and the deploy-time half grants `actions` on the profile ARN (and its
 * version-qualified pattern).
 */
export const makeSignerProfileHttpBinding = <
  I extends { profileName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Signer.StartSigningJob`. */
  tag: string;
  /** The distilled operation; `profileName` is injected from the profile. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the profile ARN + version pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (profile: SigningProfile) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ProfileName = yield* profile.profileName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${profile}))`({
            policyStatements: [
              profilePolicyStatement(profile, options.actions),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${profile.LogicalId})`)(function* (
        request: Omit<I, "profileName">,
      ) {
        return yield* op({
          ...request,
          profileName: yield* ProfileName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Signer operation (signing jobs
 * are addressed by runtime-chosen job ids; platforms are AWS-managed read-only
 * catalog entries): the binding takes no resource argument and the deploy-time
 * half grants `actions` on `Resource: ["*"]`.
 */
export const makeSignerHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Signer.DescribeSigningJob`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * IAM actions granted on `Resource: ["*"]` (the target jobs/platforms are
   * chosen per request at runtime and unknowable at deploy time).
   */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const policyStatements: PolicyStatement[] = [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: ["*"],
            },
          ];
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements,
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
