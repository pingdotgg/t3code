import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../bindingHost.ts";
import {
  assertSiteGone,
  cloudflareFixture,
  cloudRunUrl,
  liveOptions,
  logLevel,
  serviceIdentity,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!dockerAvailable)(
  "Vite SPA: deploy v1, SPA fallback, update to v2 in place, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const rootDir = yield* cloneFixture(
        cloudflareFixture("vite-spa-fixture"),
        {
          prefix: "alchemy-vite-gcp-",
          tempRoot,
          entries: ["index.html", "package.json", "src"],
        },
      );
      const index = path.join(rootDir, "index.html");
      const original = yield* fs.readFileString(index);
      const writeVersion = (version: string) =>
        fs.writeFileString(
          index,
          original.replaceAll(
            "Vite SPA fixture",
            `Vite SPA fixture ${version}`,
          ),
        );
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* GCP.Website.Vite("Web", {
              rootDir,
              memo: { include: ["index.html", "src/**", "package.json"] },
              tags: { suite: "website" },
            });
            return { site };
          }),
        );

      yield* writeVersion("v1");
      const first = yield* deploy();
      const url = first.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      const service = serviceIdentity(first.site.service!);
      yield* expectUrlContains(`${url}/`, "Vite SPA fixture v1", {
        timeout: "180 seconds",
        label: "vite v1 index",
      });
      // SPA fallback: an unknown route serves index.html.
      yield* expectUrlContains(`${url}/counter/42`, "Vite SPA fixture v1", {
        timeout: "30 seconds",
        label: "vite spa deep link",
      });

      const observed = yield* cloudrun.getProjectsLocationsServices({
        name: service.name,
      });
      expect(observed.invokerIamDisabled).toBe(true);
      expect(observed.labels?.suite).toBe("website");

      yield* writeVersion("v2");
      const second = yield* deploy();
      expect(second.site.url).toBe(url);
      expect(second.site.service!.name).toBe(service.name);
      expect(second.site.service!.latestReadyRevision).not.toBe(
        first.site.service!.latestReadyRevision,
      );
      yield* expectUrlContains(`${url}/`, "Vite SPA fixture v2", {
        timeout: "60 seconds",
        label: "vite v2 index",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(1_200_000),
);
