import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as WorkerProxy from "../../proxy/WorkerProxy.ts";
import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../../proxy/ProxyHeaders.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

layer(localRuntimeLayer, { excludeTestServices: true })((it) => {
  it.effect(
    "preserves the proxy URL, Host, body and path across runtime restarts",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const instance = yield* proxy.serve();
        const otherInstance = yield* proxy.serve();
        expect(instance.proxySharedSecret).not.toBe(
          otherInstance.proxySharedSecret,
        );
        for (const name of ["first", "replacement"]) {
          const worker = yield* startTestWorker({
            name,
            proxySharedSecret: instance.proxySharedSecret,
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: `
            export default { async fetch(request) {
              return Response.json({ url: request.url, host: request.headers.get("host"),
                body: await request.text(),
                original: request.headers.get("Alchemy-Runtime-Original-URL"),
                secret: request.headers.get("Alchemy-Runtime-Proxy-Shared-Secret") });
            } };`,
              },
            ],
          });
          yield* instance.set(worker.baseUrl);
          const url = new URL(instance.url);
          url.pathname = "//callback/%2F";
          url.search = "?return=%2Fhome&x=1&x=2";
          const result = yield* Effect.promise(() =>
            fetch(url, {
              method: "POST",
              body: "hello",
              headers: {
                [HEADER_ORIGINAL_URL]: "https://forged.example/",
                [HEADER_PROXY_SHARED_SECRET]: "forged",
              },
            }).then((res) => res.json()),
          );
          expect(result).toEqual({
            url: url.href,
            host: url.host,
            body: "hello",
            original: null,
            secret: null,
          });

          const direct = yield* worker.fetchJson("/direct", {
            headers: { [HEADER_ORIGINAL_URL]: "https://forged.example/" },
          });
          expect(direct).toMatchObject({
            url: new URL("/direct", worker.baseUrl).href,
            original: null,
            secret: null,
          });
          const trusted = yield* worker.fetchJson("/callback", {
            headers: {
              [HEADER_ORIGINAL_URL]: "https://public.example:8443/callback?x=1",
              [HEADER_PROXY_SHARED_SECRET]: instance.proxySharedSecret,
            },
          });
          expect(trusted).toMatchObject({
            url: "https://public.example:8443/callback?x=1",
            host: "public.example:8443",
            original: null,
            secret: null,
          });
          const forged = yield* worker.fetch("/direct", {
            headers: {
              [HEADER_ORIGINAL_URL]: "https://forged.example/",
              [HEADER_PROXY_SHARED_SECRET]: "forged",
            },
          });
          expect(forged.status).toBe(400);
          const otherProxy = yield* worker.fetch("/direct", {
            headers: {
              [HEADER_PROXY_SHARED_SECRET]: otherInstance.proxySharedSecret,
            },
          });
          expect(otherProxy.status).toBe(400);
        }
      }),
  );
});
