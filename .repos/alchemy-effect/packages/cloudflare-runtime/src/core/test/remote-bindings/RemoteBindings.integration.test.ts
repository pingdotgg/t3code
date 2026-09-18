import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  Ai,
  Artifacts,
  D1,
  Images,
  KvNamespace,
  R2Bucket,
  Service,
} from "../../bindings/index.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";

/**
 * Single integration spec that provisions one worker with every remote
 * binding type and exercises each through HTTP routes.
 *
 * The spec is gated on `CLOUDFLARE_ACCOUNT_ID` so the rest of the test
 * suite stays fast and credential-free. The pre-existing resource IDs are
 * supplied via env vars to avoid needing provisioning permissions in CI:
 *
 * - `CLOUDFLARE_ACCOUNT_ID`   - target account
 * - `TEST_KV_NAMESPACE_ID`    - id of an existing KV namespace
 * - `TEST_R2_BUCKET_NAME`     - name of an existing R2 bucket
 * - `TEST_D1_DATABASE_ID`     - id of an existing D1 database
 * - `TEST_SERVICE_WORKER_NAME` - name of an already-deployed worker that
 *                                responds with 200 to a GET /
 * - `TEST_ARTIFACTS_NAMESPACE` - name of an existing artifacts namespace
 *
 * Bindings whose remote helper takes only a name (Ai, Images, Browser,
 * VersionMetadata) work without extra env config.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const kvNamespaceId = process.env.TEST_KV_NAMESPACE_ID;
const r2BucketName = process.env.TEST_R2_BUCKET_NAME;
const d1DatabaseId = process.env.TEST_D1_DATABASE_ID;
const serviceWorker = process.env.TEST_SERVICE_WORKER_NAME;
const artifactsNamespace = process.env.TEST_ARTIFACTS_NAMESPACE;

const ROUTER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/kv": {
          if (!env.KV) return new Response("no-kv", { status: 412 });
          await env.KV.put("__runtime-test", "ok", { expirationTtl: 60 });
          const value = await env.KV.get("__runtime-test");
          return new Response(value);
        }
        case "/r2": {
          if (!env.R2) return new Response("no-r2", { status: 412 });
          await env.R2.put("__runtime-test", "ok-r2");
          const obj = await env.R2.get("__runtime-test");
          const text = obj ? await obj.text() : null;
          await env.R2.delete("__runtime-test");
          return new Response(text);
        }
        case "/d1": {
          if (!env.DB) return new Response("no-d1", { status: 412 });
          const result = await env.DB.prepare("SELECT 1 AS one").first();
          return Response.json(result);
        }
        case "/svc": {
          if (!env.SVC) return new Response("no-svc", { status: 412 });
          const upstream = await env.SVC.fetch(new Request("https://upstream/"));
          return new Response(String(upstream.status));
        }
        case "/ai": {
          if (!env.AI) return new Response("no-ai", { status: 412 });
          return new Response(typeof env.AI.run === "function" ? "ai-bound" : "ai-missing");
        }
        case "/images": {
          if (!env.IMAGES) return new Response("no-images", { status: 412 });
          return new Response(typeof env.IMAGES.input === "function" ? "images-bound" : "images-missing");
        }
        case "/artifacts": {
          if (!env.ARTIFACTS) return new Response("no-artifacts", { status: 412 });
          return new Response(typeof env.ARTIFACTS.fetch === "function" ? "artifacts-bound" : "artifacts-missing");
        }
      }
    } catch (error) {
      return new Response(String(error?.stack ?? error), { status: 500 });
    }
    return new Response("not found", { status: 404 });
  }
};
`;

describe.skipIf(!accountId)("RemoteBindings (integration)", () => {
  const services = RuntimeServices.layerRuntime({
    api: { accountId: accountId! },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Credentials.fromEnv(),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
  );

  const remoteBindings = [
    Ai.remote("AI"),
    Images.remote("IMAGES"),
    ...(kvNamespaceId ? [KvNamespace.remote("KV", kvNamespaceId)] : []),
    ...(r2BucketName ? [R2Bucket.remote("R2", r2BucketName)] : []),
    ...(d1DatabaseId ? [D1.remote("DB", d1DatabaseId)] : []),
    ...(serviceWorker ? [Service.remote("SVC", serviceWorker)] : []),
    ...(artifactsNamespace
      ? [Artifacts.remote("ARTIFACTS", artifactsNamespace)]
      : []),
  ];

  type RouteCase = {
    label: string;
    path: string;
    expectStatus?: number;
    expectBodyMatches?: RegExp;
    skip?: boolean;
  };

  const cases: ReadonlyArray<RouteCase> = [
    { label: "Ai", path: "/ai", expectBodyMatches: /ai-bound/ },
    { label: "Images", path: "/images", expectBodyMatches: /images-bound/ },
    {
      label: "KV",
      path: "/kv",
      expectBodyMatches: /^ok$/,
      skip: !kvNamespaceId,
    },
    {
      label: "R2",
      path: "/r2",
      expectBodyMatches: /^ok-r2$/,
      skip: !r2BucketName,
    },
    {
      label: "D1",
      path: "/d1",
      expectBodyMatches: /"one":\s*1/,
      skip: !d1DatabaseId,
    },
    {
      label: "Service",
      path: "/svc",
      expectBodyMatches: /^\d{3}$/,
      skip: !serviceWorker,
    },
    {
      label: "Artifacts",
      path: "/artifacts",
      expectBodyMatches: /artifacts-bound/,
      skip: !artifactsNamespace,
    },
  ];

  it("starts a worker with all remote bindings and exercises each route", async () => {
    const program = Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const baseUrl = yield* runtime.start({
        name: "cf-runtime-remote-it",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: remoteBindings,
        modules: [
          { name: "main.js", type: "ESModule", content: ROUTER_SCRIPT },
        ],
      });
      const results: Array<{ label: string; status: number; body: string }> =
        [];
      for (const { label, path, skip } of cases) {
        if (skip) continue;
        const response = yield* Effect.promise(() =>
          fetch(new URL(path, baseUrl)),
        );
        const body = yield* Effect.promise(() => response.text());
        results.push({ label, status: response.status, body });
      }
      return results;
    }).pipe(Effect.provide(services), Effect.scoped);

    const results = await Effect.runPromise(program);
    for (const result of results) {
      const matchingCase = cases.find((c) => c.label === result.label)!;
      expect(
        result.status,
        `[${result.label}] status was ${result.status}, body=${result.body}`,
      ).toBe(matchingCase.expectStatus ?? 200);
      if (matchingCase.expectBodyMatches) {
        expect(
          result.body,
          `[${result.label}] body did not match ${matchingCase.expectBodyMatches}`,
        ).toMatch(matchingCase.expectBodyMatches);
      }
    }
  }, 120_000);
});
