import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "diag list",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Cloudflare.LoadBalancer.Monitor);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:loadbalancer", "live"],
    timeout: 60_000,
  },
);
