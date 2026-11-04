import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { assertSiteGone, cloudRunUrl, liveOptions, logLevel, serviceIdentity } from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

// Built in place: vinext and its RSC toolchain resolve only from the
// example's own node_modules (build output is gitignored there).
const rootDir = pathe.resolve(import.meta.dirname, "../../../../../examples/fly-website-vinext");

test.provider(
  "Vinext: deploy, GET page and env-backed API route, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.Vinext("Web", {
            rootDir,
            memo: {
              include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
            },
            env: { GREETING: "Hello from vinext on Cloud Run!" },
          });
          return { site };
        }),
      );

      const url = deployed.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      const service = serviceIdentity(deployed.site.service!);
      yield* expectUrlContains(`${url}/`, "Hello from vinext on Fly!", {
        timeout: "180 seconds",
        label: "vinext page",
      });
      yield* expectUrlContains(`${url}/api/hello?name=Alchemy`, "Hello from vinext on Cloud Run!", {
        timeout: "30 seconds",
        label: "vinext api env",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(1_200_000),
);
