import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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

export type ProductType =
  | "CLOUD_FORMATION_TEMPLATE"
  | "EXTERNAL"
  | "TERRAFORM_OPEN_SOURCE"
  | "TERRAFORM_CLOUD"
  | "MARKETPLACE";

export interface ProvisioningArtifactProps {
  /**
   * Name of the provisioning artifact (product version), e.g. `v1`.
   * Updatable in place.
   * @default "v1"
   */
  name?: string;
  /**
   * Description of the provisioning artifact. Updatable in place.
   */
  description?: string;
  /**
   * HTTPS S3 URL of the CloudFormation template for this version, e.g.
   * `https://my-bucket.s3.us-west-2.amazonaws.com/template.json`.
   * Changing the template URL replaces the product.
   */
  templateUrl: string;
  /**
   * Skips CloudFormation template validation at create time.
   * @default false
   */
  disableTemplateValidation?: boolean;
}

export interface ProductProps {
  /**
   * Name of the product. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Name changes are applied in place.
   */
  productName?: string;
  /**
   * The owner of the product (person, team, or organization). Updatable
   * in place.
   */
  owner: string;
  /**
   * Description of the product. Updatable in place.
   */
  description?: string;
  /**
   * The distributor of the product. Updatable in place.
   */
  distributor?: string;
  /**
   * Support information about the product. Updatable in place.
   */
  supportDescription?: string;
  /**
   * Contact email for product support. Updatable in place.
   */
  supportEmail?: string;
  /**
   * Contact URL for product support. Must be an `https` URL. Updatable
   * in place.
   */
  supportUrl?: string;
  /**
   * The type of product. Changing it replaces the product.
   * @default "CLOUD_FORMATION_TEMPLATE"
   */
  productType?: ProductType;
  /**
   * The initial provisioning artifact (product version) created with the
   * product. Changing its `templateUrl` replaces the product.
   */
  provisioningArtifact: ProvisioningArtifactProps;
  /**
   * Tags to apply to the product. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Product extends Resource<
  "AWS.ServiceCatalog.Product",
  ProductProps,
  {
    /** The auto-generated product ID (e.g. `prod-abc123`). */
    productId: string;
    /** The ARN of the product. */
    productArn: string;
    /** The name of the product. */
    productName: string;
    /** The ID of the provisioning artifact created with the product. */
    provisioningArtifactId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Service Catalog product — a CloudFormation-backed offering
 * (or Terraform/external equivalent) with one or more provisioning
 * artifacts (versions) that principals can launch from a portfolio.
 *
 * @resource
 * @section Creating a Product
 * @example CloudFormation Product
 * ```typescript
 * import * as ServiceCatalog from "alchemy/AWS/ServiceCatalog";
 *
 * const product = yield* ServiceCatalog.Product("VpcProduct", {
 *   owner: "platform-team",
 *   description: "Standard VPC baseline",
 *   provisioningArtifact: {
 *     name: "v1",
 *     templateUrl: "https://my-bucket.s3.us-west-2.amazonaws.com/vpc.json",
 *   },
 * });
 * ```
 *
 * @example Product with Support Information
 * ```typescript
 * const product = yield* ServiceCatalog.Product("VpcProduct", {
 *   owner: "platform-team",
 *   supportEmail: "platform@example.com",
 *   supportUrl: "https://wiki.example.com/vpc-product",
 *   supportDescription: "Slack #platform for questions",
 *   provisioningArtifact: {
 *     templateUrl: "https://my-bucket.s3.us-west-2.amazonaws.com/vpc.json",
 *   },
 * });
 * ```
 *
 * @section Publishing to a Portfolio
 * @example Associate the product with a portfolio
 * ```typescript
 * yield* ServiceCatalog.PortfolioProductAssociation("ToolsVpc", {
 *   portfolioId: portfolio.portfolioId,
 *   productId: product.productId,
 * });
 * ```
 */
export const Product = Resource<Product>("AWS.ServiceCatalog.Product");

export const ProductProvider = () =>
  Provider.effect(
    Product,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ProductProps, "productName">,
      ) {
        return (
          props.productName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      // Observe by ID (typed NotFound → undefined), falling back to a
      // name lookup when state was lost.
      const observe = Effect.fn(function* (
        selector: { Id: string } | { Name: string },
      ) {
        return yield* servicecatalog
          .describeProductAsAdmin(selector)
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttributes = (
        described: servicecatalog.DescribeProductAsAdminOutput,
      ) => {
        const summary = described.ProductViewDetail?.ProductViewSummary;
        return {
          productId: summary?.ProductId ?? "",
          productArn: described.ProductViewDetail?.ProductARN ?? "",
          productName: summary?.Name ?? "",
          provisioningArtifactId:
            described.ProvisioningArtifactSummaries?.[0]?.Id ?? "",
        };
      };

      return Product.Provider.of({
        stables: ["productId", "productArn"],
        list: () =>
          Effect.gen(function* () {
            const details = yield* servicecatalog.searchProductsAsAdmin
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.ProductViewDetails ?? [],
                  ),
                ),
              );
            const items = yield* Effect.forEach(
              details,
              (d) => {
                const productId = d.ProductViewSummary?.ProductId;
                if (
                  productId === undefined ||
                  d.ProductARN === undefined ||
                  d.ProductViewSummary?.Name === undefined
                ) {
                  return Effect.succeed(undefined);
                }
                // Hydrate the artifact ID; a product can vanish between
                // enumeration and hydration, so tolerate NotFound per item.
                return servicecatalog
                  .listProvisioningArtifacts({ ProductId: productId })
                  .pipe(
                    Effect.map((r) => ({
                      productId,
                      productArn: d.ProductARN!,
                      productName: d.ProductViewSummary!.Name!,
                      provisioningArtifactId:
                        r.ProvisioningArtifactDetails?.[0]?.Id ?? "",
                    })),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );
              },
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is Product["Attributes"] => item !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const described = output?.productId
            ? yield* observe({ Id: output.productId })
            : yield* observe({ Name: yield* createName(id, olds ?? {}) });
          if (!described?.ProductViewDetail?.ProductViewSummary?.ProductId) {
            return undefined;
          }
          const attrs = toAttributes(described);
          return (yield* hasAlchemyTags(id, tagRecord(described.Tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // The initial provisioning artifact's template and the product
          // type are immutable — changing either replaces the product.
          if (
            olds.provisioningArtifact?.templateUrl !==
            news.provisioningArtifact.templateUrl
          ) {
            return { action: "replace" } as const;
          }
          if (
            (olds.productType ?? "CLOUD_FORMATION_TEMPLATE") !==
            (news.productType ?? "CLOUD_FORMATION_TEMPLATE")
          ) {
            return { action: "replace" } as const;
          }
          // everything else is an in-place update
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const productName = yield* createName(id, news);
          const productType = news.productType ?? "CLOUD_FORMATION_TEMPLATE";
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. OBSERVE — by cached ID, falling back to the deterministic name.
          let described = output?.productId
            ? yield* observe({ Id: output.productId })
            : undefined;
          if (!described?.ProductViewDetail?.ProductViewSummary?.ProductId) {
            described = yield* observe({ Name: productName });
          }

          // 2. ENSURE — create when missing; the idempotency token (derived
          // from the instance ID) makes a retried create converge.
          if (!described?.ProductViewDetail?.ProductViewSummary?.ProductId) {
            const created = yield* servicecatalog.createProduct({
              Name: productName,
              Owner: news.owner,
              Description: news.description,
              Distributor: news.distributor,
              SupportDescription: news.supportDescription,
              SupportEmail: news.supportEmail,
              SupportUrl: news.supportUrl,
              ProductType: productType,
              Tags: createTagsList(desiredTags),
              ProvisioningArtifactParameters: {
                Name: news.provisioningArtifact.name ?? "v1",
                Description: news.provisioningArtifact.description,
                Type:
                  productType === "MARKETPLACE"
                    ? "MARKETPLACE_AMI"
                    : productType,
                Info: {
                  LoadTemplateFromURL: news.provisioningArtifact.templateUrl,
                },
                DisableTemplateValidation:
                  news.provisioningArtifact.disableTemplateValidation,
              },
              IdempotencyToken: idempotencyToken(instanceId),
            });
            described = yield* observe({
              Id: created.ProductViewDetail!.ProductViewSummary!.ProductId!,
            });
          }

          const summary = described!.ProductViewDetail!.ProductViewSummary!;
          const productId = summary.ProductId!;

          // 3a. SYNC product details + tags — diff observed against desired
          // and apply only the delta in a single updateProduct call.
          const observedTags = tagRecord(described!.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          const changes: {
            Name?: string;
            Owner?: string;
            Description?: string;
            Distributor?: string;
            SupportDescription?: string;
            SupportEmail?: string;
            SupportUrl?: string;
          } = {};
          if (summary.Name !== productName) changes.Name = productName;
          if (summary.Owner !== news.owner) changes.Owner = news.owner;
          if (
            news.description !== undefined &&
            summary.ShortDescription !== news.description
          ) {
            changes.Description = news.description;
          }
          if (
            news.distributor !== undefined &&
            summary.Distributor !== news.distributor
          ) {
            changes.Distributor = news.distributor;
          }
          if (
            news.supportDescription !== undefined &&
            summary.SupportDescription !== news.supportDescription
          ) {
            changes.SupportDescription = news.supportDescription;
          }
          if (
            news.supportEmail !== undefined &&
            summary.SupportEmail !== news.supportEmail
          ) {
            changes.SupportEmail = news.supportEmail;
          }
          if (
            news.supportUrl !== undefined &&
            summary.SupportUrl !== news.supportUrl
          ) {
            changes.SupportUrl = news.supportUrl;
          }
          if (
            Object.keys(changes).length > 0 ||
            upsert.length > 0 ||
            removed.length > 0
          ) {
            yield* servicecatalog.updateProduct({
              Id: productId,
              ...changes,
              AddTags: upsert.length > 0 ? upsert : undefined,
              RemoveTags: removed.length > 0 ? removed : undefined,
            });
          }

          // 3b. SYNC the provisioning artifact's mutable fields (name and
          // description; the template itself is immutable → replacement).
          const artifact = described!.ProvisioningArtifactSummaries?.[0];
          const provisioningArtifactId =
            output?.provisioningArtifactId ?? artifact?.Id ?? "";
          const desiredArtifactName = news.provisioningArtifact.name ?? "v1";
          if (
            artifact?.Id !== undefined &&
            (artifact.Name !== desiredArtifactName ||
              (news.provisioningArtifact.description !== undefined &&
                artifact.Description !== news.provisioningArtifact.description))
          ) {
            yield* servicecatalog.updateProvisioningArtifact({
              ProductId: productId,
              ProvisioningArtifactId: artifact.Id,
              Name: desiredArtifactName,
              Description: news.provisioningArtifact.description,
            });
          }

          yield* session.note(productId);
          return {
            productId,
            productArn: described!.ProductViewDetail!.ProductARN!,
            productName,
            provisioningArtifactId: artifact?.Id ?? provisioningArtifactId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A product still associated with a portfolio reports
          // ResourceInUseException; the disassociation settles asynchronously.
          yield* retryWhileResourceInUse(
            servicecatalog.deleteProduct({ Id: output.productId }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
