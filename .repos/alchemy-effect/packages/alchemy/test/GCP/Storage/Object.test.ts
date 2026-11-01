import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getObject = (bucket: string, object: string) =>
  storage
    .getObjects({ bucket, object })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilObjectGone = (bucket: string, object: string) =>
  getObject(bucket, object).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (found) => found === undefined,
      times: 10,
    }),
  );

const waitUntilBucketGone = (bucketName: string) =>
  storage.getBuckets({ bucket: bucketName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "inline content: create, update, move key, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (key: string, content: string, cacheControl?: string) =>
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Objects", {
            forceDestroy: true,
          });
          const object = yield* GCP.Storage.Object("Page", {
            bucketName: bucket.bucketName,
            key,
            content,
            cacheControl,
          });
          return { bucket, object };
        });

      const created = yield* stack.deploy(program("index.html", "<h1>v1</h1>"));
      const bucketName = created.bucket.bucketName;
      expect(created.object.key).toEqual("index.html");
      expect(created.object.contentType).toEqual("text/html; charset=utf-8");
      expect(created.object.url).toEqual(
        `https://storage.googleapis.com/${bucketName}/index.html`,
      );

      const live = yield* getObject(bucketName, "index.html");
      expect(live?.contentType).toEqual("text/html; charset=utf-8");
      expect(live?.size).toEqual(String("<h1>v1</h1>".length));
      expect(live?.metadata?.["alchemy-id"]).toEqual("page");

      // Redeploying identical content leaves the live generation alone.
      const same = yield* stack.deploy(program("index.html", "<h1>v1</h1>"));
      expect(same.object.generation).toEqual(created.object.generation);

      // New content and headers converge in one upload.
      const updated = yield* stack.deploy(
        program("index.html", "<h1>v2</h1>", "no-cache"),
      );
      expect(updated.object.generation).not.toEqual(created.object.generation);
      const liveUpdated = yield* getObject(bucketName, "index.html");
      expect(liveUpdated?.cacheControl).toEqual("no-cache");
      expect(liveUpdated?.md5Hash).toEqual(updated.object.md5Hash);

      // Moving the key replaces the object; the old key is deleted.
      const moved = yield* stack.deploy(
        program("home.html", "<h1>v2</h1>", "no-cache"),
      );
      expect(moved.object.key).toEqual("home.html");
      expect(yield* getObject(bucketName, "home.html")).toBeDefined();
      yield* waitUntilObjectGone(bucketName, "index.html");

      yield* stack.destroy();
      yield* waitUntilObjectGone(bucketName, "home.html");
      yield* waitUntilBucketGone(bucketName);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 180_000 },
);

test.provider(
  "Files uploads a directory and re-uploads edited files",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-gcs-files-",
      });
      yield* fs.makeDirectory(path.join(dir, "assets"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "index.html"), "<h1>one</h1>");
      yield* fs.writeFileString(
        path.join(dir, "assets", "app.css"),
        "body{color:red}",
      );
      yield* fs.writeFile(
        path.join(dir, "assets", "logo.png"),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      );

      const program = Effect.gen(function* () {
        const bucket = yield* GCP.Storage.Bucket("Site", {
          forceDestroy: true,
        });
        const objects = yield* GCP.Storage.Files("SiteFiles", {
          bucketName: bucket.bucketName,
          path: dir,
          prefix: "site",
          cacheControl: (key) =>
            key.endsWith(".html") ? "no-cache" : undefined,
        });
        return { bucket, objects };
      });

      const first = yield* stack.deploy(program);
      const bucketName = first.bucket.bucketName;
      const byKey = Object.fromEntries(
        first.objects.map((object) => [object.key, object]),
      );
      expect(Object.keys(byKey).sort()).toEqual([
        "site/assets/app.css",
        "site/assets/logo.png",
        "site/index.html",
      ]);

      const html = yield* getObject(bucketName, "site/index.html");
      expect(html?.contentType).toEqual("text/html; charset=utf-8");
      expect(html?.cacheControl).toEqual("no-cache");
      const css = yield* getObject(bucketName, "site/assets/app.css");
      expect(css?.contentType).toEqual("text/css; charset=utf-8");
      const png = yield* getObject(bucketName, "site/assets/logo.png");
      expect(png?.contentType).toEqual("image/png");

      // Editing a file without touching any prop re-uploads only that file.
      yield* fs.writeFileString(path.join(dir, "index.html"), "<h1>two</h1>");
      const second = yield* stack.deploy(program);
      const secondByKey = Object.fromEntries(
        second.objects.map((object) => [object.key, object]),
      );
      expect(secondByKey["site/index.html"]!.generation).not.toEqual(
        byKey["site/index.html"]!.generation,
      );
      expect(secondByKey["site/assets/app.css"]!.generation).toEqual(
        byKey["site/assets/app.css"]!.generation,
      );

      // Removing a file deletes its object on the next deploy.
      yield* fs.remove(path.join(dir, "assets", "logo.png"));
      yield* stack.deploy(program);
      yield* waitUntilObjectGone(bucketName, "site/assets/logo.png");

      yield* stack.destroy();
      yield* waitUntilBucketGone(bucketName);
    }).pipe(Effect.scoped, logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 180_000 },
);

test.provider(
  "bucket website config: set, change, remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (website?: GCP.Storage.BucketWebsite) =>
        GCP.Storage.Bucket("Web", { forceDestroy: true, website });

      const created = yield* stack.deploy(
        program({ mainPageSuffix: "index.html", notFoundPage: "404.html" }),
      );
      expect(created.website).toEqual({
        mainPageSuffix: "index.html",
        notFoundPage: "404.html",
      });

      const changed = yield* stack.deploy(
        program({ mainPageSuffix: "home.html" }),
      );
      const live = yield* storage.getBuckets({ bucket: changed.bucketName });
      expect(live.website?.mainPageSuffix).toEqual("home.html");
      expect(live.website?.notFoundPage).toBeUndefined();

      const removed = yield* stack.deploy(program(undefined));
      expect(removed.website).toBeUndefined();
      const liveRemoved = yield* storage.getBuckets({
        bucket: removed.bucketName,
      });
      expect(liveRemoved.website?.mainPageSuffix).toBeUndefined();

      yield* stack.destroy();
      yield* waitUntilBucketGone(created.bucketName);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 180_000 },
);
