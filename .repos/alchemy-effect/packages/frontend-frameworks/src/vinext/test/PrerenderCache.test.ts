import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import { buildVinextPrerenderKVPairs } from "../PrerenderCache.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(
    path.resolve(
      import.meta.dirname,
      "../../../../../examples/cloudflare-website-vinext/node_modules/vinext",
    ),
  );
  const server = yield* fs.makeTempDirectoryScoped({
    prefix: "vinext-prerender-",
  });
  const build = Effect.tryPromise(() => buildVinextPrerenderKVPairs(root, server));
  return { fs, path, server, build };
});

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | import("effect/Scope").Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

describe("vinext prerender cache", () => {
  it("returns no seeds for missing manifests or prerender output", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, server, build } = yield* fixture;
        expect(yield* build).toEqual({
          routeCount: 0,
          pairs: [],
          warnings: [],
        });
        yield* fs.writeFileString(
          path.join(server, "vinext-prerender.json"),
          JSON.stringify({ buildId: "build", routes: [] }),
        );
        expect(yield* build).toEqual({
          routeCount: 0,
          pairs: [],
          warnings: [],
        });
      }),
    ));

  it("encodes HTML, RSC, and metadata with the runtime cache codec", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, server, build } = yield* fixture;
        const output = path.join(server, "prerendered-routes");
        yield* fs.makeDirectory(output);
        yield* fs.writeFileString(path.join(output, "index.html"), "<h1>prerendered</h1>");
        yield* fs.writeFileString(path.join(output, "index.rsc"), "rsc payload");
        yield* fs.writeFileString(
          path.join(server, "vinext-prerender.json"),
          JSON.stringify({
            buildId: "build",
            routes: [
              {
                route: "/",
                router: "app",
                status: "rendered",
                revalidate: 60,
                expire: 120,
                stale: 30,
                tags: ["home"],
              },
            ],
          }),
        );
        const result = yield* build;
        expect(result.routeCount).toBe(1);
        expect(result.warnings).toEqual([]);
        expect(result.pairs).toHaveLength(2);
        for (const pair of result.pairs) {
          const entry = JSON.parse(pair.value);
          expect(entry.value.kind).toBe("APP_PAGE");
          expect(entry.tags).toContain("home");
          expect(entry.cacheControl).toEqual({
            revalidate: 60,
            expire: 120,
            stale: 30,
          });
          expect(entry.revalidateAt - entry.lastModified).toBe(60_000);
          expect(entry.expireAt - entry.lastModified).toBe(120_000);
          expect(pair.expirationTtl).toBe(30 * 24 * 3600);
        }
        expect(JSON.parse(result.pairs[0]!.value).value.html).toBe("<h1>prerendered</h1>");
        expect(JSON.parse(result.pairs[1]!.value).value.rscData).toBe("cnNjIHBheWxvYWQ=");
      }),
    ));
});
