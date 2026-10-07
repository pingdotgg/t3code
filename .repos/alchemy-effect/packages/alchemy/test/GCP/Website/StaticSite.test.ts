import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
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
  "StaticSite: build v1, rebuild to v2 in place, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* cloneFixture(cloudflareFixture("staticsite-fixture"), {
        prefix: "alchemy-staticsite-gcp-",
        tempRoot,
        entries: ["src", "build.sh"],
      });
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const site = yield* GCP.Website.StaticSite("Blog", {
              path: cwd,
              build: { command: "bash build.sh", output: "dist" },
              memo: { include: ["src/**", "build.sh"] },
            });
            return { site };
          }),
        );

      const first = yield* deploy();
      const url = first.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      const service = serviceIdentity(first.site.service!);
      yield* expectUrlContains(`${url}/`, "StaticSite fixture v1", {
        timeout: "180 seconds",
        label: "static v1",
      });

      const index = path.join(cwd, "src/index.html");
      yield* fs.writeFileString(
        index,
        (yield* fs.readFileString(index)).replaceAll(
          "fixture v1",
          "fixture v2",
        ),
      );
      const second = yield* deploy();
      expect(second.site.url).toBe(url);
      expect(second.site.service!.codeHash).not.toBe(
        first.site.service!.codeHash,
      );
      yield* expectUrlContains(`${url}/`, "StaticSite fixture v2", {
        timeout: "60 seconds",
        label: "static v2",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(1_200_000),
);
