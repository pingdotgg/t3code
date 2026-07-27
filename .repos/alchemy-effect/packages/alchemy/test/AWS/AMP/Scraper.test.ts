import * as AWS from "@/AWS";
import { Scraper, ScraperLoggingConfiguration, Workspace } from "@/AWS/AMP";
import * as Logs from "@/AWS/Logs";
import * as Test from "@/Test/Alchemy";
import * as amp from "@distilled.cloud/aws/amp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probes: prove the scraper API surface returns the typed errors the
// Scraper provider relies on (observe/delete both catch
// ResourceNotFoundException), at near-zero cost.
test.provider(
  "describeScraper returns a typed not-found for a nonexistent scraper",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        amp.describeScraper({
          scraperId: "s-00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 30_000 },
);

test.provider(
  "getDefaultScraperConfiguration returns Prometheus YAML",
  () =>
    Effect.gen(function* () {
      const response = yield* amp.getDefaultScraperConfiguration({});
      const yaml = yield* Effect.sync(() =>
        new TextDecoder().decode(response.configuration),
      );
      expect(yaml).toContain("scrape_configs");
    }),
  { timeout: 30_000 },
);

// Full scraper lifecycle requires a live Amazon EKS cluster to scrape and
// takes many minutes to provision (the service creates network interfaces
// and an IAM role) — far beyond the suite's provisioning budget. Gate it
// behind an entitled/provisioned environment:
//   AWS_TEST_AMP_SCRAPER=1
//   AWS_TEST_AMP_SCRAPER_CLUSTER_ARN=arn:aws:eks:...:cluster/my-cluster
//   AWS_TEST_AMP_SCRAPER_SUBNET_IDS=subnet-a,subnet-b
test.provider.skipIf(!process.env.AWS_TEST_AMP_SCRAPER)(
  "scraper lifecycle (create, update alias, logging, destroy)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterArn = process.env.AWS_TEST_AMP_SCRAPER_CLUSTER_ARN!;
      const subnetIds = process.env.AWS_TEST_AMP_SCRAPER_SUBNET_IDS!.split(",");
      const defaultConfig = yield* amp.getDefaultScraperConfiguration({});
      const scrapeConfiguration = yield* Effect.sync(() =>
        new TextDecoder().decode(defaultConfig.configuration),
      );

      const program = (alias: string) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace("ScraperWorkspace", {
            alias: "alchemy-test-amp-scraper",
            tags: { Environment: "test" },
          });
          const scraper = yield* Scraper("Scraper", {
            alias,
            scrapeConfiguration,
            source: { eksConfiguration: { clusterArn, subnetIds } },
            destinationWorkspaceArn: workspace.workspaceArn,
            tags: { Environment: "test" },
          });
          const logs = yield* Logs.LogGroup("ScraperLogs", {
            logGroupName: "/aws/vendedlogs/prometheus/alchemy-test-scraper",
            retention: "1 day",
          });
          const logging = yield* ScraperLoggingConfiguration("Logging", {
            scraperId: scraper.scraperId,
            logGroupArn: logs.logGroupArn,
          });
          return { workspace, scraper, logging };
        });

      const created = yield* stack.deploy(program("alchemy-test-scraper"));
      const scraperId = created.scraper.scraperId;
      expect(scraperId).toMatch(/^s-/);
      expect(created.scraper.status).toBe("ACTIVE");
      expect(created.logging.scraperId).toBe(scraperId);

      // Out-of-band verification via distilled.
      const described = yield* amp.describeScraper({ scraperId });
      expect(described.scraper.tags?.["alchemy::id"]).toBe("Scraper");

      // In-place alias update — same scraper id survives.
      const updated = yield* stack.deploy(program("alchemy-test-scraper-2"));
      expect(updated.scraper.scraperId).toBe(scraperId);
      expect(updated.scraper.alias).toBe("alchemy-test-scraper-2");

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);
