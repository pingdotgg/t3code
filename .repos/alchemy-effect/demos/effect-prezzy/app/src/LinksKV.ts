import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LinkNotFound, Links, LinkStoreError, newCode, type Link } from "./Links.ts";

/** `Links` stored in a Cloudflare KV namespace that this Layer owns. */
export const LinksKV = Layer.effect(
  Links,
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.KV.Namespace("Links");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);

    const get = Effect.fn(function* (code: string) {
      const link = yield* kv.get<Link>(code, "json");
      if (!link) return yield* new LinkNotFound({ code });
      return link;
    });

    return {
      create: Effect.fn(
        function* (url: string) {
          const link: Link = { code: newCode(), url, createdAt: Date.now() };
          yield* kv.put(link.code, JSON.stringify(link));
          return link;
        },
        Effect.mapError((cause) => new LinkStoreError({ cause })),
      ),
      get: (code: string) =>
        get(code).pipe(
          Effect.catchTag("NamespaceError", (cause) => Effect.fail(new LinkStoreError({ cause }))),
        ),
      list: Effect.fn(
        function* () {
          const { keys } = yield* kv.list();
          const links = yield* Effect.forEach(keys, (key) => kv.get<Link>(key.name, "json"), {
            concurrency: 10,
          });
          return links
            .filter((link): link is Link => link !== null)
            .sort((a, b) => b.createdAt - a.createdAt);
        },
        Effect.mapError((cause) => new LinkStoreError({ cause })),
      ),
      setPreview: Effect.fn(
        function* (code: string, preview: Link["preview"] & {}) {
          const link = yield* get(code);
          yield* kv.put(code, JSON.stringify({ ...link, preview }));
        },
        Effect.catchTag("NamespaceError", (cause) => Effect.fail(new LinkStoreError({ cause }))),
      ),
    };
  }),
).pipe(Layer.provide(Cloudflare.KV.ReadWriteNamespaceBinding));
