import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Region } from "../Region.ts";
import type { PublicRepository } from "./Repository.ts";

/**
 * Shared HTTP scaffolding for the Amazon ECR Public runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and (for the
 * repository-scoped builder) the injected repository name is boilerplate.
 *
 * Amazon ECR Public is a single global registry served exclusively from the
 * `us-east-1` endpoint, so every operation is resolved with the Region
 * pinned via {@link pinEcrPublic} — exactly like the resource provider in
 * `Repository.ts`.
 *
 * Per the `ecr-public` service authorization reference, repository-scoped
 * actions authorize on the repository ARN, while registry-level actions
 * (`GetAuthorizationToken`, `DescribeRegistries`, `GetRegistryCatalogData`)
 * support no repository resource type, so the registry builder grants on
 * `Resource: ["*"]`.
 */

const US_EAST_1 = "us-east-1";

/** Pin a distilled `ecr-public` effect to the service's home region. */
export const pinEcrPublic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(US_EAST_1)));

/**
 * Build the impl Effect for an operation scoped to one
 * {@link PublicRepository}. The runtime callable injects the bound
 * repository's name as the request's `repositoryName`; the deploy-time half
 * grants `iamActions` on the repository's ARN.
 */
export const makePublicRepositoryHttpBinding = <
  I extends { repositoryName: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"DescribeImages"`.
   */
  capability: string;
  /** IAM actions granted on the repository ARN. */
  iamActions: readonly string[];
  /** The distilled operation; `repositoryName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinEcrPublic(options.operation);

    return Effect.fn(function* (repository: PublicRepository) {
      const RepositoryName = yield* repository.repositoryName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ECRPublic.${options.capability}(${repository}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [repository.repositoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ECRPublic.${options.capability}(${repository.LogicalId})`,
      )(function* (request?: Omit<I, "repositoryName">) {
        return yield* op({
          ...request,
          repositoryName: yield* RepositoryName,
        } as unknown as I);
      });
    });
  });

/**
 * Build the impl Effect for a registry-level ECR Public operation
 * (`GetAuthorizationToken`, `DescribeRegistries`, `GetRegistryCatalogData` —
 * none of which are repository-scoped, so the grant is on
 * `Resource: ["*"]`).
 */
export const makePublicRegistryHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetAuthorizationToken"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinEcrPublic(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ECRPublic.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.ECRPublic.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
