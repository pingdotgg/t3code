// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's `test/http/forwarded-proto.spec.ts`: the entry
 * worker honors `X-Forwarded-Proto` from TLS-terminating proxies unless a
 * trusted proxy supplied the original URL.
 *
 * Not ported: "preserves a configured upstream origin" (this runtime has no
 * `upstream` option) and the WebSocket variant (Node's WebSocket client
 * can't set `Host`/`X-Forwarded-Proto`; the URL rewrite is shared with plain
 * requests).
 */
import * as http from "node:http";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../../globals/ProxyHeaders.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const proxySharedSecret = "test-proxy-secret";

const startWorker = startTestWorker({
  name: "forwarded-proto",
  proxySharedSecret,
  compatibilityDate: "2025-01-01",
  compatibilityFlags: [],
  bindings: [],
  modules: [
    {
      name: "main.js",
      type: "ESModule",
      content: `export default {
        fetch(request) {
          return Response.json({
            url: request.url,
            forwardedProto: request.headers.get("X-Forwarded-Proto"),
          });
        }
      };`,
    },
  ],
});

/** `fetch` can't override `Host`, so send raw HTTP requests. */
const request = (url: URL, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const req = http.request(url, { headers }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(JSON.parse(body)));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      }),
  );

layer(localRuntimeLayer, { excludeTestServices: true })("X-Forwarded-Proto", (it) => {
  for (const { header, scheme } of [
    { header: undefined, scheme: "http" },
    { header: "https", scheme: "https" },
    { header: "http", scheme: "http" },
    { header: "HTTPS, http", scheme: "https" },
    { header: "invalid", scheme: "http" },
  ]) {
    it.effect(`network requests honor forwarded protocol ${header}`, () =>
      Effect.gen(function* () {
        const worker = yield* startWorker;
        const body = yield* request(new URL("/path?query=1", worker.baseUrl), {
          Host: "app.example.com",
          ...(header === undefined ? {} : { "X-Forwarded-Proto": header }),
        });
        expect(body).toEqual({
          url: `${scheme}://app.example.com/path?query=1`,
          forwardedProto: header ?? null,
        });
      }),
    );
  }

  it.effect("preserves a public port that was the physical protocol's default", () =>
    Effect.gen(function* () {
      const worker = yield* startWorker;
      const body = yield* request(worker.baseUrl, {
        Host: "app.example.com:80",
        "X-Forwarded-Proto": "https",
      });
      expect(body).toEqual({ url: "https://app.example.com:80/", forwardedProto: "https" });
    }),
  );

  it.effect("preserves explicit URLs from a trusted proxy", () =>
    Effect.gen(function* () {
      const worker = yield* startWorker;
      const body = yield* request(worker.baseUrl, {
        [HEADER_ORIGINAL_URL]: "https://explicit.example.com/path",
        [HEADER_PROXY_SHARED_SECRET]: proxySharedSecret,
        "X-Forwarded-Proto": "http",
      });
      expect(body).toEqual({ url: "https://explicit.example.com/path", forwardedProto: "http" });
    }),
  );
});
