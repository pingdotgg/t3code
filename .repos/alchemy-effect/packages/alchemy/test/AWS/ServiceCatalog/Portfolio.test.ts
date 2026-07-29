import * as AWS from "@/AWS";
import { Portfolio } from "@/AWS/ServiceCatalog";
import * as Test from "@/Test/Alchemy";
import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class PortfolioStillExists extends Data.TaggedError("PortfolioStillExists")<{
  portfolioId: string;
}> {}

const assertPortfolioGone = (portfolioId: string) =>
  servicecatalog.describePortfolio({ Id: portfolioId }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new PortfolioStillExists({ portfolioId })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PortfolioStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "creates, updates, and deletes a portfolio",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const portfolio = yield* Portfolio("TestPortfolio", {
            providerName: "alchemy-tests",
            description: "portfolio lifecycle test",
            tags: { purpose: "lifecycle" },
          });
          return {
            portfolioId: portfolio.portfolioId,
            portfolioArn: portfolio.portfolioArn,
            portfolioName: portfolio.portfolioName,
          };
        }),
      );
      expect(created.portfolioId).toMatch(/^port-/);
      expect(created.portfolioArn).toContain(":catalog:");

      // out-of-band verify via distilled
      const described = yield* servicecatalog.describePortfolio({
        Id: created.portfolioId,
      });
      expect(described.PortfolioDetail?.DisplayName).toBe(
        created.portfolioName,
      );
      expect(described.PortfolioDetail?.ProviderName).toBe("alchemy-tests");
      expect(described.PortfolioDetail?.Description).toBe(
        "portfolio lifecycle test",
      );
      const tags = Object.fromEntries(
        (described.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.purpose).toBe("lifecycle");
      expect(tags["alchemy::id"]).toBe("TestPortfolio");

      // in-place update of provider name, description, and tags
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Portfolio("TestPortfolio", {
            providerName: "alchemy-tests-updated",
            description: "updated description",
            tags: { purpose: "lifecycle-updated", extra: "yes" },
          });
        }),
      );
      const updated = yield* servicecatalog.describePortfolio({
        Id: created.portfolioId,
      });
      expect(updated.PortfolioDetail?.Id).toBe(created.portfolioId);
      expect(updated.PortfolioDetail?.ProviderName).toBe(
        "alchemy-tests-updated",
      );
      expect(updated.PortfolioDetail?.Description).toBe("updated description");
      const updatedTags = Object.fromEntries(
        (updated.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.purpose).toBe("lifecycle-updated");
      expect(updatedTags.extra).toBe("yes");

      yield* stack.destroy();
      yield* assertPortfolioGone(created.portfolioId);
    }),
  { timeout: 180_000 },
);
