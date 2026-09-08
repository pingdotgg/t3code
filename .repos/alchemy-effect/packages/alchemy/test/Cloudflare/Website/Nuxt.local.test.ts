import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { isLocalId } from "@/Cloudflare/LocalRuntime";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "app",
  "server",
  "public",
];

const memoInclude = [
  "app/**",
  "server/**",
  "public/**",
  "nuxt.config.ts",
  "package.json",
];

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nuxt dev", () => {
  test.provider(
    "Nuxt dev: local dev server renders SSR with event.context.cloudflare bindings",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-dev-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "nuxt-dev-binding-marker";

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace("NuxtDevKV");
            const site = yield* Cloudflare.Website.Nuxt("NuxtLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              env: {
                TEST_BINDING: bindingMarker,
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists — and the KV namespace is emulated (a `dev:`
        // id, proof no cloud API call ran).
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(deployed.siteKv.namespaceId)).toBe(true);

        // SSR page rendered by nitro's dev server behind the proxy.
        yield* expectUrlContains(`${site.url!}/`, "NUXT_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "nuxt dev SSR home page",
        });

        // The SSR page reads `event.context.cloudflare.env.TEST_BINDING` —
        // the dev platform bridge reconstructs the runtime contract over
        // the cloudflare-runtime platform proxy.
        yield* expectUrlContains(`${site.url!}/`, `binding:${bindingMarker}`, {
          timeout: "60 seconds",
          label: "nuxt dev SSR page with event.context.cloudflare.env binding",
        });

        // API route through the same contract.
        yield* expectUrlContains(`${site.url!}/api/hello`, "api-route-ok", {
          timeout: "60 seconds",
          label: "nuxt dev API route",
        });

        // KV binding round-trip against the local simulator, through the
        // platform-proxy bridge (nitro dev worker thread → host workerd).
        const put = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=dev-key&value=dev-value`,
        );
        expect(put.put).toBe(true);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=dev-key`,
        );
        expect(got.value).toBe("dev-value");

        // ── HMR: edit an API route in place. The stack is NOT re-applied —
        // nitro's dev rebuild must pick the change up and serve it through
        // the same alchemy proxy ─────────────────────────────────────────
        const helloPath = path.join(rootDir, "server/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace('marker: "api-route-ok"', 'marker: "api-route-v2"'),
        );

        // Bounded poll until nitro's dev rebuild serves the new marker.
        yield* expectUrlContains(`${site.url!}/api/hello`, "api-route-v2", {
          timeout: "90 seconds",
          label: "nuxt dev API route after HMR edit",
        });

        // The binding bridge survived the dev-server reload: the KV binding
        // still round-trips (old key readable, new write lands).
        const stillThere = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=dev-key`,
        );
        expect(stillThere.value).toBe("dev-value");
        const put2 = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=post-hmr-key&value=post-hmr-value`,
        );
        expect(put2.put).toBe(true);
        const got2 = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=post-hmr-key`,
        );
        expect(got2.value).toBe("post-hmr-value");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the KV namespace OUT of local emulation: even
   * under `alchemy dev` the namespace is created on real Cloudflare and the
   * dev server's binding proxies to it remotely. Out-of-band reads through
   * the cloud API prove the write landed in the real namespace, and destroy
   * (with the state row stamped live) deletes it from the cloud.
   *
   * The dev platform proxy is hosted in the sidecar's runtime stack
   * (`DevContext.runtimeContext` threaded through the framework dev bridge),
   * which includes remote-bindings support — the proxy's internal layer is
   * local-only by design.
   */
  test.provider(
    "Nuxt dev: Alchemy.remote() KV namespace runs live behind the dev server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-dev-remote-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace(
              "NuxtDevRemoteKV",
            ).pipe(Alchemy.remote());
            const site = yield* Cloudflare.Website.Nuxt("NuxtRemoteKvLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: memoInclude },
              env: {
                TEST_BINDING: "nuxt-dev-remote-marker",
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );
        const site = deployed.site;

        // The site is served locally, but the remote() namespace is REAL —
        // a live cloud id, not a `dev:` fabrication.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteKv.namespaceId).toBeDefined();
        expect(deployed.siteKv.namespaceId).not.toMatch(/^dev:/);

        // Write through the dev server's remote-proxied binding.
        const put = yield* putJsonReady<{ put: boolean }>(
          `${site.url!}/api/kv?key=remote-key&value=remote-value`,
        );
        expect(put.put).toBe(true);
        const got = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=remote-key`,
        );
        expect(got.value).toBe("remote-value");

        // Out-of-band: the write is visible through the cloud KV API — the
        // remote-proxied binding really hit the live namespace.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const observed = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: deployed.siteKv.namespaceId,
            keyName: "remote-key",
          })
          .pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "KeyNotFound",
              schedule: Schedule.min([
                Schedule.exponential("1 second"),
                Schedule.spaced("3 seconds"),
              ]),
              times: 8,
            }),
            Effect.flatMap((res) =>
              Effect.tryPromise(() =>
                new Response(
                  Stream.toReadableStream(res.body) as BodyInit,
                ).text(),
              ),
            ),
          );
        expect(observed).toBe("remote-value");

        yield* stack.destroy();

        // The live namespace was deleted from the cloud on destroy (its
        // state row is stamped live, so the live provider handles the
        // delete even in a dev run).
        const gone = yield* kv
          .getNamespace({
            accountId,
            namespaceId: deployed.siteKv.namespaceId,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          );
        expect(gone).toBe(true);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});

/** GET `url` until it answers 200 with a JSON body. */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 10,
      }),
    );
  });

/** PUT (empty body) to `url` until it answers 200 with a JSON body. */
const putJsonReady = <T>(url: string) =>
  HttpClient.execute(HttpClientRequest.put(url)).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.flatMap(res.text, (responseBody) =>
            Effect.try({
              try: () => JSON.parse(responseBody) as T,
              catch: () => new Error(`non-json body: ${responseBody}`),
            }),
          )
        : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("500 millis"),
        Schedule.spaced("2 seconds"),
      ]),
      times: 10,
    }),
  );
