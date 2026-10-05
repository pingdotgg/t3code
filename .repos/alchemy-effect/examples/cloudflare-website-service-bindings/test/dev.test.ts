import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { frameworks } from "../frameworks.ts";
import Stack from "../alchemy.run.ts";

const stage = "dev-service-bindings";
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  profile: process.env.ALCHEMY_PROFILE,
  stage,
  dev: true,
});

const stack = beforeAll(
  Alchemy.destroy({ stack: Stack, stage }).pipe(Effect.andThen(deploy(Stack))),
  { timeout: 120_000 },
);
afterAll(destroy(Stack));

for (const { name, marker } of frameworks) {
  test(
    `${name}: the local Website serves its page directly`,
    Effect.gen(function* () {
      const { websiteUrl } = (yield* stack)[name]!;
      expect(websiteUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
      const response = yield* Test.getWhenReady(String(websiteUrl), {
        times: 3,
      });
      expect(response.status).toBe(200);
      expect(yield* response.text).toContain(marker);
    }).pipe(Effect.timeout("30 seconds")),
    { timeout: 35_000 },
  );
  test(
    `${name}: the Gateway reaches the Website through its service binding`,
    Effect.gen(function* () {
      const { gatewayUrl } = (yield* stack)[name]!;
      const response = yield* HttpClient.get(String(gatewayUrl));
      const body = yield* response.text;
      expect(response.status, body).toBe(200);
      expect(body).toContain(marker);
    }).pipe(Effect.timeout("10 seconds")),
    { timeout: 15_000 },
  );
}
