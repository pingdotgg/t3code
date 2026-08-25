import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Output as OutputType } from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Repository } from "./Repository.ts";

/**
 * Shared scaffolding for CodeArtifact HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeRepositoryHttpBinding({ … }))`. Everything except
 * the operation, the IAM action list, and the granted ARNs is boilerplate:
 * the runtime callable injects `domain`, `domainOwner`, and `repository`
 * from the bound {@link Repository}.
 */

/** The repository-scoping fields every CodeArtifact package operation takes. */
interface RepositoryScopedRequest {
  domain: string;
  domainOwner?: string;
  repository: string;
}

/** The bound repository's own ARN (repository-level actions). */
export const repositoryArns = (
  repository: Repository,
): OutputType<string>[] => [repository.repositoryArn];

/**
 * ARN matching every package in the bound repository
 * (`arn:…:package/{domain}/{repository}/*`) — package-level actions like
 * `codeartifact:DescribePackage` authorize against the package resource,
 * not the repository.
 */
export const packageArns = (repository: Repository): OutputType<string>[] => [
  repository.repositoryArn.pipe(
    Output.map((arn) => `${arn.replace(":repository/", ":package/")}/*`),
  ),
];

/**
 * ARNs matching every repository and every package in the bound repository's
 * domain — for operations like `codeartifact:CopyPackageVersions` that read
 * from a sibling repository in the same domain.
 */
export const domainWideArns = (repository: Repository): OutputType<string>[] =>
  ["repository", "package"].map((kind) =>
    repository.repositoryArn.pipe(
      Output.map((arn) => {
        const [prefix, rest] = arn.split(":repository/");
        return `${prefix}:${kind}/${rest!.split("/")[0]}/*`;
      }),
    ),
  );

/**
 * Build the impl Effect for a repository-scoped CodeArtifact operation. The
 * deploy-time half grants `actions` on `resources` (default: the repository
 * ARN); the runtime callable injects the bound repository's `domain`,
 * `domainOwner`, and `repository` into every request.
 *
 * Operations that scope by a differently-named field (e.g.
 * `CopyPackageVersions`' `destinationRepository`) stay bespoke in their own
 * `{Op}Http.ts` and reuse just the ARN helpers above.
 */
export const makeRepositoryHttpBinding = <
  I extends { domain: string; domainOwner?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeArtifact.ListPackages`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the repository ARN */
  resources?: (repository: Repository) => OutputType<string>[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (repository: Repository) {
      const DomainName = yield* repository.domainName;
      const DomainOwner = yield* repository.domainOwner;
      const RepositoryName = yield* repository.repositoryName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${repository}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: (options.resources ?? repositoryArns)(repository),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${repository.LogicalId})`)(function* (
        request: Omit<I, keyof RepositoryScopedRequest>,
      ) {
        const owner = yield* DomainOwner;
        return yield* op({
          ...request,
          domain: yield* DomainName,
          ...(owner === "" ? {} : { domainOwner: owner }),
          repository: yield* RepositoryName,
        } as unknown as I);
      });
    });
  });
