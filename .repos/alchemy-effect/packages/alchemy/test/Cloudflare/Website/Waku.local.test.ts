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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "waku-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "public",
  "src",
];

/**
 * Execute `request` until it answers 200 with a JSON body — the dev server
 * compiles routes lazily and briefly answers non-200 mid-rebuild.
 */
const requestJsonReady = <T>(request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.flatMap(res.text, (body) =>
              Effect.fail(
                new Error(
                  `dev server not ready: ${res.status} ${body.slice(0, 300)}`,
                ),
              ),
            ),
      ),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

/** PUT then GET `key` through the fixture's `/api/kv` route. */
const kvRoundTrip = Effect.fn(function* (
  baseUrl: string,
  key: string,
  value: string,
) {
  yield* requestJsonReady<{ ok: boolean }>(
    HttpClientRequest.put(`${baseUrl}/api/kv`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ key, value }),
    ),
  );
  return yield* requestJsonReady<{ key: string; value: string | null }>(
    HttpClientRequest.get(`${baseUrl}/api/kv?key=${encodeURIComponent(key)}`),
  );
});

/**
 * Under `alchemy dev` the whole site runs locally: the KV Namespace is
 * emulated by the local provider (a `dev:` id, no cloud API calls) and
 * waku's own dev server serves the app behind the alchemy dev proxy, with
 * the `kv_namespace` binding lowered onto the local workerd simulator.
 */
// Concurrent like the other Website suites: the Waku build runs in a
// child process with cwd = project root (core/BuildChild.ts), and the
// dev server only chdirs briefly inside the RPC sidecar during startup.
describe.concurrent("Waku dev", () => {
  test.provider(
    "Waku dev: local dev server renders RSC SSR with bindings, local KV, and HMR",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-waku-dev-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "waku-dev-binding-marker";

        const { site, siteKv } = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace("WakuLocalKV");
            const site = yield* Cloudflare.Website.Waku("WakuLocal", {
              rootDir,
              dev: { port: 0 },
              memo: {
                include: [
                  "src/**",
                  "public/**",
                  "package.json",
                  "tsconfig.json",
                ],
              },
              env: {
                MESSAGE: bindingMarker,
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists — and the namespace id carries the `dev:`
        // marker, proof the KV provider never called the cloud.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(siteKv.namespaceId)).toBe(true);

        // Dynamic RSC page rendered by waku's dev server (rsc environment
        // runs in workerd behind the proxy). Waku's cold first compile
        // (RSC + vite dep optimization) can exceed 120s when the whole
        // suite's builds and dev servers contend for the CPU.
        yield* expectUrlContains(`${site.url!}/`, "WAKU_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "waku dev dynamic home page",
        });

        // The page reads the `MESSAGE` binding from `cloudflare:workers`
        // env — proves alchemy-managed bindings reach the dev RSC server.
        yield* expectUrlContains(`${site.url!}/`, `MESSAGE=${bindingMarker}`, {
          timeout: "60 seconds",
          label: "waku dev env binding in SSR output",
        });

        // Static asset from `public/` through the dev server.
        yield* expectUrlContains(
          `${site.url!}/hello.txt`,
          "hello from public/",
          {
            timeout: "60 seconds",
            label: "waku dev static asset",
          },
        );

        // The KV binding round-trips through the `/api/kv` route against the
        // local simulator.
        const roundTrip = yield* kvRoundTrip(
          site.url!,
          "waku-dev-key",
          "kv-dev-value",
        );
        expect(roundTrip.value).toBe("kv-dev-value");

        // ── HMR: edit the page in place; the dev server rebuilds and serves
        // the new marker at the same URL without a redeploy ─────────────────
        const indexPath = path.join(rootDir, "src/pages/index.tsx");
        const index = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          index.replace("WAKU_PAGE_MARKER", "WAKU_PAGE_MARKER_V2"),
        );

        // Bounded poll; transient non-200s mid-rebuild are retried inside
        // expectUrlContains' budget.
        yield* expectUrlContains(`${site.url!}/`, "WAKU_PAGE_MARKER_V2", {
          timeout: "120 seconds",
          label: "waku dev page after HMR edit",
        });

        // The KV binding survives the rebuild: the previous write is still
        // readable and new writes land.
        const afterHmr = yield* kvRoundTrip(
          site.url!,
          "waku-dev-key-2",
          "kv-dev-value-2",
        );
        expect(afterHmr.value).toBe("kv-dev-value-2");
        const stillThere = yield* requestJsonReady<{ value: string | null }>(
          HttpClientRequest.get(`${site.url!}/api/kv?key=waku-dev-key`),
        );
        expect(stillThere.value).toBe("kv-dev-value");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the namespace OUT of local emulation: even under
   * `alchemy dev` it is created on real Cloudflare and the dev worker's
   * binding proxies to it remotely. Out-of-band reads through the cloud API
   * prove the local site's writes landed in the real namespace, and destroy
   * (stamped-mode delete path) removes it from the cloud.
   */
  test.provider(
    "Waku dev: Alchemy.remote() KV namespace runs live behind the local site",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-waku-dev-remote-",
          tempRoot,
          entries: fixtureEntries,
        });

        const { site, liveKv } = yield* stack.deploy(
          Effect.gen(function* () {
            const liveKv = yield* Cloudflare.KV.Namespace("WakuRemoteKV").pipe(
              Alchemy.remote(),
            );
            const site = yield* Cloudflare.Website.Waku("WakuLocalRemoteKV", {
              rootDir,
              dev: { port: 0 },
              memo: {
                include: [
                  "src/**",
                  "public/**",
                  "package.json",
                  "tsconfig.json",
                ],
              },
              env: {
                MESSAGE: "waku-dev-remote-marker",
                SITE_KV: liveKv,
              },
            });
            return { site, liveKv };
          }),
        );

        // The site is local, the namespace is REAL: a non-`dev:` id proves
        // the live provider ran even in a dev deploy.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(liveKv.namespaceId)).toBe(false);

        // Write through the locally-served site into the remote-proxied
        // binding.
        const roundTrip = yield* kvRoundTrip(
          site.url!,
          "waku-remote-key",
          "kv-remote-value",
        );
        expect(roundTrip.value).toBe("kv-remote-value");

        // Out-of-band: the write is visible through the cloud API — the
        // remote-proxied binding really hit the live namespace.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const rawValue = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: liveKv.namespaceId,
            keyName: "waku-remote-key",
          })
          .pipe(
            Effect.flatMap((res) =>
              Effect.tryPromise(() =>
                new Response(
                  Stream.toReadableStream(res.body) as BodyInit,
                ).text(),
              ),
            ),
            // The KV REST read can lag the proxied write — propagation is
            // documented at up to 60s and runs longer under account load
            // (a fully concurrent suite), so budget ~91s: exponential ramp
            // capped at 10s spacing.
            Effect.retry({
              while: (e) => e._tag === "KeyNotFound",
              schedule: Schedule.min([
                Schedule.exponential("1 second", 1.5),
                Schedule.spaced("10 seconds"),
              ]),
              times: 13,
            }),
          );
        expect(rawValue).toBe("kv-remote-value");

        yield* stack.destroy();

        // The live namespace was deleted from the cloud on destroy (its
        // state row is stamped live, so the live provider handles the delete
        // even in a dev run).
        const gone = yield* kv
          .getNamespace({ accountId, namespaceId: liveKv.namespaceId })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          );
        expect(gone).toBe(true);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
