import { providers } from "@alchemy.run/neon/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Server } from "alchemy/Website/Server";
import * as Effect from "effect/Effect";
import { browserRoundtrip } from "./Browser.ts";
import { bodyContaining, exampleRoot } from "./Fixture.ts";

const { test } = Test.make({ providers: providers(), dev: true });

test.provider(
  "Vocs source target isolates its dev cwd and supports interactive MDX",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const root = yield* exampleRoot("vocs");
      const framework = new URL(
        "../../../../../packages/frontend-frameworks/src/vocs/neon.ts",
        import.meta.url,
      ).href;
      const server = yield* stack.deploy(Server("Build", { root, framework, target: framework }));
      expect(server.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
      yield* bodyContaining(`${server.url}/counter`, "count:");
      yield* browserRoundtrip(String(server.url), "vocs");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:website", "local"],
    timeout: 120_000,
  },
);
