import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

export const copyViteFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* path.fromFileUrl(new URL("./fixtures/vite/", import.meta.url));
  const modules = yield* path.fromFileUrl(new URL("../../../node_modules/", import.meta.url));
  const rootDir = yield* fs.makeTempDirectoryScoped({
    prefix: "prisma-website-vite-",
  });
  yield* fs.copy(source, rootDir);
  yield* fs.symlink(modules, path.join(rootDir, "node_modules"));
  return rootDir;
});

export const bodyContaining = Effect.fn(function* (url: string, expected: string) {
  return yield* Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    const body = yield* response.text;
    if (response.status !== 200 || !body.includes(expected)) {
      return yield* Effect.fail(
        new Error(`${url} returned ${response.status} without ${expected}: ${body.slice(0, 500)}`),
      );
    }
    return body;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }));
});
