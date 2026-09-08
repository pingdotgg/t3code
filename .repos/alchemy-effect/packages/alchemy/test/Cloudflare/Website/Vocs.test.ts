import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../../../../examples/cloudflare-website-vocs",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  "package.json",
  "public",
  "src",
  "tsconfig.json",
  "vocs.config.ts",
];

const vocsProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  compatibility: { date: "2026-03-10" },
  memo: {
    include: [
      "src/**",
      "public/**",
      "package.json",
      "tsconfig.json",
      "vocs.config.ts",
    ],
  },
});

describe.concurrent("Vocs", () => {
  test.provider(
    "Vocs: deploys SSR, MDX, generated and public assets, and memoizes rebuilds",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vocs-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deploy = () =>
          stack.deploy(Cloudflare.Website.Vocs("VocsSite", vocsProps(rootDir)));

        const site1 = yield* deploy();

        expect(site1.url).toBeDefined();
        expect(site1.hash?.input).toBeDefined();
        yield* expectWorkerExists(site1.workerName, accountId);

        yield* expectUrlContains(`${site1.url!}/`, "Alchemy with Vocs", {
          timeout: "120 seconds",
          label: "Vocs SSR shell and home page",
        });
        yield* expectUrlContains(`${site1.url!}/guide`, "Deployment guide", {
          timeout: "60 seconds",
          label: "Vocs prerendered MDX guide",
        });
        yield* expectUrlContains(
          `${site1.url!}/counter`,
          "Interactive component",
          {
            timeout: "60 seconds",
            label: "Vocs MDX client-component page",
          },
        );
        yield* expectUrlContains(
          `${site1.url!}/hello.txt`,
          "hello from the Vocs public directory",
          {
            timeout: "60 seconds",
            label: "Vocs public asset",
          },
        );
        yield* expectUrlContains(
          `${site1.url!}/llms.txt`,
          "Alchemy with Vocs",
          {
            timeout: "60 seconds",
            label: "Vocs generated llms asset",
          },
        );

        const site2 = yield* deploy();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.url).toBe(site1.url);

        const pagePath = path.join(rootDir, "src/pages/index.mdx");
        const page = yield* fs.readFileString(pagePath);
        yield* fs.writeFileString(
          pagePath,
          page.replace(
            "No Wrangler configuration or Vocs adapter setup is required.",
            "This Vocs page was updated by a deployment.",
          ),
        );

        const site3 = yield* deploy();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(
          `${site3.url!}/?__alchemy_cb=${Date.now()}`,
          "This Vocs page was updated by a deployment.",
          {
            timeout: "180 seconds",
            label: "Vocs page after source update",
          },
        );

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
