import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { idempotencyToken, retryWhileResourceInUse } from "./internal.ts";

export interface PortfolioProps {
  /**
   * Display name of the portfolio (1-100 characters). Portfolio display
   * names are not unique in an account; the portfolio's identity is its
   * auto-generated ID. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Display name changes are applied in place.
   */
  displayName?: string;
  /**
   * Name of the person or organization that owns the portfolio
   * (for example a team name). Updatable in place.
   */
  providerName: string;
  /**
   * Description of the portfolio. Updatable in place.
   */
  description?: string;
  /**
   * Tags to apply to the portfolio. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Portfolio extends Resource<
  "AWS.ServiceCatalog.Portfolio",
  PortfolioProps,
  {
    /** The auto-generated portfolio ID (e.g. `port-abc123`). */
    portfolioId: string;
    /** The ARN of the portfolio. */
    portfolioArn: string;
    /** The display name of the portfolio. */
    portfolioName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Service Catalog portfolio — a container that organizes products
 * and grants access to them for a set of principals.
 *
 * @resource
 * @section Creating a Portfolio
 * @example Basic Portfolio
 * ```typescript
 * import * as ServiceCatalog from "alchemy/AWS/ServiceCatalog";
 *
 * const portfolio = yield* ServiceCatalog.Portfolio("Tools", {
 *   providerName: "platform-team",
 * });
 * ```
 *
 * @example Portfolio with Description and Tags
 * ```typescript
 * const portfolio = yield* ServiceCatalog.Portfolio("Tools", {
 *   displayName: "engineering-tools",
 *   providerName: "platform-team",
 *   description: "Self-service infrastructure for engineering",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @section Granting Access
 * @example Associate a principal (IAM role)
 * ```typescript
 * yield* ServiceCatalog.PrincipalPortfolioAssociation("DevAccess", {
 *   portfolioId: portfolio.portfolioId,
 *   principalArn: role.roleArn,
 * });
 * ```
 *
 * @section Adding Products
 * @example Associate a product
 * ```typescript
 * yield* ServiceCatalog.PortfolioProductAssociation("ToolsVpcProduct", {
 *   portfolioId: portfolio.portfolioId,
 *   productId: product.productId,
 * });
 * ```
 */
export const Portfolio = Resource<Portfolio>("AWS.ServiceCatalog.Portfolio");

export const PortfolioProvider = () =>
  Provider.effect(
    Portfolio,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<PortfolioProps, "displayName">,
      ) {
        return (
          props.displayName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      // Portfolio display names are not unique, so the fallback lookup
      // (state lost, no cached ID) scans for the deterministic name we
      // would have created and takes the first match.
      const findByDisplayName = Effect.fn(function* (displayName: string) {
        return yield* servicecatalog.listPortfolios.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.PortfolioDetails ?? [])
              .find((p) => p.DisplayName === displayName),
          ),
        );
      });

      const observe = Effect.fn(function* (portfolioId: string) {
        return yield* servicecatalog
          .describePortfolio({ Id: portfolioId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Portfolio.Provider.of({
        stables: ["portfolioId", "portfolioArn"],
        list: () =>
          servicecatalog.listPortfolios.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.PortfolioDetails ?? [])
                .filter(
                  (d) => d.Id != null && d.ARN != null && d.DisplayName != null,
                )
                .map((d) => ({
                  portfolioId: d.Id!,
                  portfolioArn: d.ARN!,
                  portfolioName: d.DisplayName!,
                })),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          let portfolioId = output?.portfolioId;
          if (portfolioId === undefined) {
            const displayName = yield* createName(id, olds ?? {});
            const found = yield* findByDisplayName(displayName);
            portfolioId = found?.Id;
          }
          if (portfolioId === undefined) return undefined;
          const described = yield* observe(portfolioId);
          const detail = described?.PortfolioDetail;
          if (!detail?.Id) return undefined;
          const attrs = {
            portfolioId: detail.Id,
            portfolioArn: detail.ARN!,
            portfolioName: detail.DisplayName!,
          };
          return (yield* hasAlchemyTags(id, tagRecord(described?.Tags)))
            ? attrs
            : Unowned(attrs);
        }),
        // Display name, provider name, description, and tags are all
        // updatable in place — no diff needed (identity is the generated ID).
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const displayName = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. OBSERVE — cloud is authoritative; output caches the ID only.
          let described = output?.portfolioId
            ? yield* observe(output.portfolioId)
            : undefined;
          if (!described?.PortfolioDetail?.Id) {
            const found = yield* findByDisplayName(displayName);
            described = found?.Id ? yield* observe(found.Id) : undefined;
          }

          // 2. ENSURE — create when missing. The idempotency token (derived
          // from the instance ID) makes a retried create converge on the
          // same portfolio instead of duplicating it.
          if (!described?.PortfolioDetail?.Id) {
            const created = yield* servicecatalog.createPortfolio({
              DisplayName: displayName,
              ProviderName: news.providerName,
              Description: news.description,
              Tags: createTagsList(desiredTags),
              IdempotencyToken: idempotencyToken(instanceId),
            });
            described = yield* observe(created.PortfolioDetail!.Id!);
          }

          const detail = described!.PortfolioDetail!;
          const portfolioId = detail.Id!;

          // 3. SYNC — diff observed details + tags against desired and apply
          // only the delta in a single updatePortfolio call.
          const observedTags = tagRecord(described!.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          const changes: {
            DisplayName?: string;
            ProviderName?: string;
            Description?: string;
          } = {};
          if (detail.DisplayName !== displayName) {
            changes.DisplayName = displayName;
          }
          if (detail.ProviderName !== news.providerName) {
            changes.ProviderName = news.providerName;
          }
          if (
            news.description !== undefined &&
            detail.Description !== news.description
          ) {
            changes.Description = news.description;
          }
          if (
            Object.keys(changes).length > 0 ||
            upsert.length > 0 ||
            removed.length > 0
          ) {
            yield* servicecatalog.updatePortfolio({
              Id: portfolioId,
              ...changes,
              AddTags: upsert.length > 0 ? upsert : undefined,
              RemoveTags: removed.length > 0 ? removed : undefined,
            });
          }

          yield* session.note(portfolioId);
          return {
            portfolioId,
            portfolioArn: detail.ARN!,
            portfolioName: displayName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Disassociations of products/principals settle asynchronously, so
          // a portfolio delete right after teardown of its associations can
          // transiently report ResourceInUseException.
          yield* retryWhileResourceInUse(
            servicecatalog.deletePortfolio({ Id: output.portfolioId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
