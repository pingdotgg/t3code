/**
 * Repro for the workers.dev URL regression under `alchemy dev`:
 * a Worker previously deployed live (stamped `providerMode: "live"`) is
 * replaced live → local by a dev run. The stack output referencing
 * `worker.url` must resolve to the LOCAL dev server URL (localhost), not
 * the deployed workers.dev / custom-domain URL.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { inDev } from "../../test.resources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const script = `export default {
  async fetch() {
    return Response.json({ ok: true });
  },
};`;

test.provider(
  "worker.url resolves to localhost after a live → local mode switch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const worker = yield* Cloudflare.Worker("url-mode-switch-worker", {
          script,
        });
        return { url: worker.url, urls: worker.urls };
      });

      // 1. live deploy: url is the workers.dev URL, row stamped live.
      const live = yield* stack.deploy(program);
      expect(String(live.url)).toContain("workers.dev");

      // 2. dev run over the same stage: live → local replacement. The
      //    stack output must now resolve to the local dev server URL.
      const dev = yield* inDev(stack.deploy(program));
      expect(String(dev.url)).toContain("localhost");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

/**
 * A state row written before provider modes existed (pre-beta.66) has no
 * `providerMode` stamp. Such a row was necessarily deployed LIVE — the old
 * engine had no local mode. A dev run must therefore treat it as live and
 * plan the live → local replacement; assuming it is "already local" leaves
 * the deployed cloud attrs (workers.dev / custom-domain URL) masquerading
 * as the local instance and never starts a dev server.
 */
test.provider(
  "a legacy (unstamped) live row is replaced by a dev run, not assumed local",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const worker = yield* Cloudflare.Worker("url-legacy-row-worker", {
          script,
        });
        return { url: worker.url, urls: worker.urls };
      });

      // 1. live deploy, then simulate a pre-providerMode row.
      const live = yield* stack.deploy(program);
      expect(String(live.url)).toContain("workers.dev");

      const fqn = "url-legacy-row-worker";
      const state = yield* yield* State;
      const stk = yield* Stack;
      const row = (yield* state.get({
        stack: stk.name,
        stage: stk.stage,
        fqn,
      })) as ResourceState;
      yield* state.set({
        stack: stk.name,
        stage: stk.stage,
        fqn,
        value: { ...row, providerMode: undefined },
      });

      // 2. dev run: the worker must come up locally.
      const dev = yield* inDev(stack.deploy(program));
      expect(String(dev.url)).toContain("localhost");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

test.provider(
  "worker.url with a custom domain resolves to localhost after live → local",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostname = `url-mode-switch.${zoneName}`;
      const program = Effect.gen(function* () {
        const worker = yield* Cloudflare.Worker("url-mode-switch-domain", {
          script,
          domain: hostname,
        });
        return { url: worker.url, urls: worker.urls };
      });

      // 1. live deploy: url is the custom domain, row stamped live.
      const live = yield* stack.deploy(program);
      expect(String(live.url)).toBe(`https://${hostname}`);

      // 2. dev run: live → local replacement. The output must resolve to
      //    the local dev server URL, not the deployed custom domain.
      const dev = yield* inDev(stack.deploy(program));
      expect(String(dev.url)).toContain("localhost");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
