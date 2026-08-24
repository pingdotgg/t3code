import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { awaitVisible } from "./internal.ts";

export type PrincipalType = "IAM" | "IAM_PATTERN";

export interface PrincipalPortfolioAssociationProps {
  /**
   * ID of the portfolio to grant access to. Changing it replaces the
   * association.
   */
  portfolioId: string;
  /**
   * ARN of the IAM principal (user, group, or role) — or an ARN pattern
   * with wildcards when `principalType` is `IAM_PATTERN`. Changing it
   * replaces the association.
   */
  principalArn: string;
  /**
   * Whether `principalArn` is a concrete IAM ARN (`IAM`) or a wildcard
   * pattern (`IAM_PATTERN`). Changing it replaces the association.
   * @default "IAM"
   */
  principalType?: PrincipalType;
}

export interface PrincipalPortfolioAssociation extends Resource<
  "AWS.ServiceCatalog.PrincipalPortfolioAssociation",
  PrincipalPortfolioAssociationProps,
  {
    /** ID of the portfolio. */
    portfolioId: string;
    /** ARN (or pattern) of the associated principal. */
    principalArn: string;
    /** The principal type of the association. */
    principalType: PrincipalType;
  },
  never,
  Providers
> {}

/**
 * Grants an IAM principal (user, group, or role) access to a Service
 * Catalog portfolio, allowing it to browse and launch the portfolio's
 * products.
 *
 * @resource
 * @section Granting Access
 * @example Associate an IAM role
 * ```typescript
 * import * as ServiceCatalog from "alchemy/AWS/ServiceCatalog";
 *
 * yield* ServiceCatalog.PrincipalPortfolioAssociation("DevAccess", {
 *   portfolioId: portfolio.portfolioId,
 *   principalArn: role.roleArn,
 * });
 * ```
 *
 * @example Associate a wildcard principal pattern
 * ```typescript
 * yield* ServiceCatalog.PrincipalPortfolioAssociation("AllDevRoles", {
 *   portfolioId: portfolio.portfolioId,
 *   principalArn: "arn:aws:iam:::role/dev-*",
 *   principalType: "IAM_PATTERN",
 * });
 * ```
 */
export const PrincipalPortfolioAssociation =
  Resource<PrincipalPortfolioAssociation>(
    "AWS.ServiceCatalog.PrincipalPortfolioAssociation",
  );

export const PrincipalPortfolioAssociationProvider = () =>
  Provider.effect(
    PrincipalPortfolioAssociation,
    Effect.gen(function* () {
      // Enumerate the portfolio's principals and check for ours. A missing
      // portfolio means the association is gone too.
      const isAssociated = Effect.fn(function* (
        portfolioId: string,
        principalArn: string,
      ) {
        return yield* servicecatalog.listPrincipalsForPortfolio
          .pages({ PortfolioId: portfolioId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.Principals ?? [])
                .some((p) => p.PrincipalARN === principalArn),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(false),
            ),
          );
      });

      return PrincipalPortfolioAssociation.Provider.of({
        stables: ["portfolioId", "principalArn", "principalType"],
        // Service Catalog has no account-wide principal-association API. Walk
        // every portfolio so unsafe nuke can remove principals before their
        // parent portfolios. AWS may replace the ARN of a deleted IAM role
        // with its stable principal ID (ARO...); preserve that value because
        // the disassociate API accepts it.
        list: () =>
          Effect.gen(function* () {
            const portfolioIds = yield* servicecatalog.listPortfolios
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((pages) =>
                  Array.from(pages)
                    .flatMap((page) => page.PortfolioDetails ?? [])
                    .flatMap((portfolio) =>
                      portfolio.Id === undefined ? [] : [portfolio.Id],
                    ),
                ),
              );

            const associations = yield* Effect.forEach(
              portfolioIds,
              (portfolioId) =>
                servicecatalog.listPrincipalsForPortfolio
                  .pages({ PortfolioId: portfolioId })
                  .pipe(
                    Stream.runCollect,
                    Effect.map((pages) =>
                      Array.from(pages)
                        .flatMap((page) => page.Principals ?? [])
                        .flatMap((principal) => {
                          if (principal.PrincipalARN === undefined) return [];
                          const principalType =
                            principal.PrincipalType === "IAM"
                              ? ("IAM" as const)
                              : principal.PrincipalType === "IAM_PATTERN"
                                ? ("IAM_PATTERN" as const)
                                : undefined;
                          if (principalType === undefined) return [];
                          return [
                            {
                              portfolioId,
                              principalArn: principal.PrincipalARN,
                              principalType,
                            },
                          ];
                        }),
                    ),
                    // A portfolio can disappear between enumeration and
                    // association hydration.
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 5 },
            );
            return associations.flat();
          }),
        // Existence-only resource — every property is part of its identity.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.portfolioId !== news.portfolioId ||
            olds.principalArn !== news.principalArn ||
            (olds.principalType ?? "IAM") !== (news.principalType ?? "IAM")
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const portfolioId = output?.portfolioId ?? olds?.portfolioId;
          const principalArn = output?.principalArn ?? olds?.principalArn;
          if (portfolioId === undefined || principalArn === undefined) {
            return undefined;
          }
          return (yield* isAssociated(portfolioId, principalArn))
            ? {
                portfolioId,
                principalArn,
                principalType:
                  output?.principalType ?? olds?.principalType ?? "IAM",
              }
            : undefined;
        }),
        // Existence-only: observe → if missing, associate. No sync step.
        reconcile: Effect.fn(function* ({ news, session }) {
          const principalType = news.principalType ?? "IAM";
          if (!(yield* isAssociated(news.portfolioId, news.principalArn))) {
            yield* servicecatalog.associatePrincipalWithPortfolio({
              PortfolioId: news.portfolioId,
              PrincipalARN: news.principalArn,
              PrincipalType: principalType,
            });
            // The principal list is eventually consistent — wait (bounded)
            // until the association is visible so a subsequent read converges.
            yield* awaitVisible(
              isAssociated(news.portfolioId, news.principalArn),
            );
          }
          yield* session.note(`${news.portfolioId}/${news.principalArn}`);
          return {
            portfolioId: news.portfolioId,
            principalArn: news.principalArn,
            principalType,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (yield* isAssociated(output.portfolioId, output.principalArn)) {
            yield* servicecatalog
              .disassociatePrincipalFromPortfolio({
                PortfolioId: output.portfolioId,
                PrincipalARN: output.principalArn,
                PrincipalType: output.principalType,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }
        }),
      });
    }),
  );
