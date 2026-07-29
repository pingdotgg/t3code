import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import {
  Portfolio,
  PortfolioProductAssociation,
  PrincipalPortfolioAssociation,
  Product,
} from "@/AWS/ServiceCatalog";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "alchemy Service Catalog association test template",
  Resources: {
    NoOp: { Type: "AWS::CloudFormation::WaitConditionHandle" },
  },
});

class PortfolioStillExists extends Data.TaggedError(
  "AssocPortfolioStillExists",
)<{ portfolioId: string }> {}

const assertPortfolioGone = (portfolioId: string) =>
  servicecatalog.describePortfolio({ Id: portfolioId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new PortfolioStillExists({ portfolioId })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "AssocPortfolioStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "associates a product and a principal with a portfolio",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: a bucket to host the CloudFormation template.
      const phase1 = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("AssocTemplateBucket", {
            forceDestroy: true,
          });
          return { bucketName: bucket.bucketName, region: bucket.region };
        }),
      );
      yield* s3.putObject({
        Bucket: phase1.bucketName,
        Key: "assoc-template.json",
        Body: new TextEncoder().encode(TEMPLATE),
        ContentType: "application/json",
      });
      const templateUrl = `https://${phase1.bucketName}.s3.${phase1.region}.amazonaws.com/assoc-template.json`;

      // Phase 2: portfolio + product + principal + both associations.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Bucket("AssocTemplateBucket", { forceDestroy: true });
          const portfolio = yield* Portfolio("AssocPortfolio", {
            providerName: "alchemy-tests",
          });
          const product = yield* Product("AssocProduct", {
            owner: "alchemy-tests",
            provisioningArtifact: { templateUrl },
          });
          const role = yield* Role("AssocPrincipalRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "servicecatalog.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          yield* PortfolioProductAssociation("ProductInPortfolio", {
            portfolioId: portfolio.portfolioId,
            productId: product.productId,
          });
          yield* PrincipalPortfolioAssociation("RoleAccess", {
            portfolioId: portfolio.portfolioId,
            principalArn: role.roleArn,
          });
          return {
            portfolioId: portfolio.portfolioId,
            productId: product.productId,
            roleArn: role.roleArn,
          };
        }),
      );

      // out-of-band verify both associations via distilled
      const portfolios = yield* servicecatalog.listPortfoliosForProduct({
        ProductId: deployed.productId,
      });
      expect(
        (portfolios.PortfolioDetails ?? []).some(
          (d) => d.Id === deployed.portfolioId,
        ),
      ).toBe(true);

      const principals = yield* servicecatalog.listPrincipalsForPortfolio({
        PortfolioId: deployed.portfolioId,
      });
      expect(
        (principals.Principals ?? []).some(
          (p) => p.PrincipalARN === deployed.roleArn,
        ),
      ).toBe(true);

      // Account-wide provider enumeration drives `alchemy unsafe nuke`.
      // Both association providers must discover their child resources so
      // teardown can schedule them before the portfolio and product.
      const productAssociationProvider = yield* Provider.findProvider(
        PortfolioProductAssociation,
      );
      const principalAssociationProvider = yield* Provider.findProvider(
        PrincipalPortfolioAssociation,
      );
      const [productAssociations, principalAssociations] = yield* Effect.all([
        productAssociationProvider.list(),
        principalAssociationProvider.list(),
      ]);
      expect(
        productAssociations.some(
          (association) =>
            association.portfolioId === deployed.portfolioId &&
            association.productId === deployed.productId,
        ),
      ).toBe(true);
      expect(
        principalAssociations.some(
          (association) =>
            association.portfolioId === deployed.portfolioId &&
            association.principalArn === deployed.roleArn &&
            association.principalType === "IAM",
        ),
      ).toBe(true);

      // idempotent re-deploy — associations already exist, reconcile no-ops
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Bucket("AssocTemplateBucket", { forceDestroy: true });
          const portfolio = yield* Portfolio("AssocPortfolio", {
            providerName: "alchemy-tests",
          });
          const product = yield* Product("AssocProduct", {
            owner: "alchemy-tests",
            provisioningArtifact: { templateUrl },
          });
          const role = yield* Role("AssocPrincipalRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "servicecatalog.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          yield* PortfolioProductAssociation("ProductInPortfolio", {
            portfolioId: portfolio.portfolioId,
            productId: product.productId,
          });
          yield* PrincipalPortfolioAssociation("RoleAccess", {
            portfolioId: portfolio.portfolioId,
            principalArn: role.roleArn,
          });
        }),
      );

      // teardown removes associations first, then the portfolio/product
      yield* stack.destroy();
      yield* assertPortfolioGone(deployed.portfolioId);
    }),
  { timeout: 240_000 },
);
