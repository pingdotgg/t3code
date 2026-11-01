import { Function } from "@/Neon/Function.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import { packageWebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import {
  bodyContaining,
  buildPortableExample,
  exampleRoot,
} from "./Fixture.ts";

const { test } = Test.make({ providers: providers() });

for (const slug of ["nextjs", "vocs"] as const)
  test.provider.skipIf(!process.env.NEON_WEBSITE_FRESH)(
    `fresh ${slug} portable artifact serves production requests`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* exampleRoot(slug);
        const next = slug === "nextjs";
        const pixel = path.join(root, "public/neon-artifact-pixel.png");
        if (next) {
          const original = (yield* fs.exists(pixel))
            ? yield* fs.readFile(pixel)
            : undefined;
          yield* Effect.addFinalizer(() =>
            (original
              ? fs.writeFile(pixel, original)
              : fs.remove(pixel, { force: true })
            ).pipe(Effect.orDie),
          );
          yield* fs.writeFile(
            pixel,
            yield* Effect.sync(() =>
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            ),
          );
        }
        const artifact = yield* packageWebsiteArtifact(
          yield* buildPortableExample(slug, root),
        );
        const directory = yield* fs.makeTempDirectoryScoped();
        const zip = path.join(directory, "site.zip");
        yield* fs.writeFile(zip, artifact.archive);
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("Project", {
              region: "aws-us-east-2",
            });
            return yield* Function("Site", {
              project,
              artifact: { zip },
              env: { NODE_ENV: "production" },
            });
          }),
        );
        const url = site.url.replace(/\/$/, "");
        yield* Effect.logInfo(`Fresh ${slug} artifact: ${url}`);
        const html = yield* bodyContaining(`${url}/`, "Neon");
        for (const method of ["GET", "HEAD"] as const) {
          const response = yield* method === "HEAD"
            ? HttpClient.head(`${url}/example.json`)
            : HttpClient.get(`${url}/example.json`);
          expect(response.status).toBe(200);
          const body = yield* response.text;
          if (method === "HEAD") expect(body).toBe("");
          else expect(body).toContain("framework");
        }
        const assets = [
          ...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/g),
        ]
          .map((match) => match[1]!)
          .filter((url) => url.startsWith("/"));
        expect(assets.length).toBeGreaterThan(0);
        for (const asset of assets.slice(0, 3)) {
          const response = yield* HttpClient.get(`${url}${asset}`);
          expect(response.status).toBe(200);
          expect((yield* response.arrayBuffer).byteLength).toBeGreaterThan(0);
        }
        if (next) {
          const image = yield* HttpClient.get(
            `${url}/_next/image?url=%2Fneon-artifact-pixel.png&w=64&q=75`,
            { headers: { accept: "image/webp" } },
          );
          expect(image.status).toBe(200);
          expect(image.headers["content-type"]).toContain("image/webp");
          expect((yield* image.arrayBuffer).byteLength).toBeGreaterThan(0);
          const stream = yield* HttpClient.get(`${url}/api/stream`);
          expect(stream.status).toBe(200);
          expect(stream.headers["content-type"]).toContain("text/event-stream");
          expect(yield* stream.text).toBe("data: first\n\ndata: second\n\n");
        } else yield* bodyContaining(`${url}/guide`, "Guide");
        yield* stack.destroy();
        expect(
          yield* getProject({ project_id: site.projectId }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    {
      tags: [
        "provider:neon",
        "provider:neon:function",
        "provider:neon:project",
        "provider:neon:website",
        "live",
      ],
      timeout: 120_000,
    },
  );
