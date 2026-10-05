import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import { frameworks } from "../frameworks.ts";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  profile: process.env.ALCHEMY_PROFILE,
});
const stack = beforeAll(
  Effect.sync(Test.defaultStage).pipe(
    Effect.flatMap((stage) => Alchemy.destroy({ stack: Stack, stage })),
    Effect.andThen(deploy(Stack)),
  ),
  { timeout: 120_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

for (const { name, marker } of frameworks) {
  test(
    `${name}: the deployed Gateway serves its private Website`,
    Effect.gen(function* () {
      const { gatewayUrl } = (yield* stack)[name]!;
      expect(gatewayUrl).toBeString();
      const response = yield* Test.getWhenReady(String(gatewayUrl), {
        times: 8,
      });
      expect(response.status).toBe(200);
      expect(yield* response.text).toContain(marker);
    }).pipe(Effect.timeout("60 seconds")),
    { timeout: 65_000 },
  );
}
