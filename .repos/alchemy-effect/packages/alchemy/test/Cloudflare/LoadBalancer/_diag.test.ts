import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "diag list",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.LoadBalancer.Monitor,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 60_000 },
);
