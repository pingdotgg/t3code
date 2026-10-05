import * as Nextjs from "@alchemy.run/frontend-frameworks/nextjs/neon";
import * as Vocs from "@alchemy.run/frontend-frameworks/vocs/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import { functionTextSamples } from "../FunctionRollout.ts";

const buildDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "serve-neon.mjs",
  "neon-node-adapter.mjs",
  ".alchemy",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".astro",
  ".vite",
  ".vinxi",
  ".nitro",
  ".cache",
  ".turbo",
  ".vercel",
  "tsconfig.tsbuildinfo",
]);

/** Isolate mutable sources and build output while reusing installed dependencies. */
export const exampleRoot = Effect.fn(function* (slug: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* path.fromFileUrl(
    new URL(`../../../../../examples/neon-website-${slug}/`, import.meta.url),
  );
  // Keep relative tsconfig paths and avoid ignored roots that confuse Tailwind's scanner.
  const directory = path.dirname(source);
  yield* fs.makeDirectory(directory, { recursive: true });
  const root = yield* fs.makeTempDirectoryScoped({
    directory,
    prefix: `neon-website-${slug}-`,
  });
  for (const name of yield* fs.readDirectory(source)) {
    if (
      !buildDirectories.has(name) &&
      !name.startsWith(".env") &&
      name !== ".npmrc"
    ) {
      yield* fs.copy(path.join(source, name), path.join(root, name));
    }
  }
  const installed = path.join(source, "node_modules");
  const dependencies = path.join(root, "node_modules");
  yield* fs.makeDirectory(dependencies);
  for (const name of yield* fs.readDirectory(installed)) {
    if (name.startsWith(".") && name !== ".bin") continue;
    if (name.startsWith("@")) {
      yield* fs.makeDirectory(path.join(dependencies, name));
      for (const pkg of yield* fs.readDirectory(path.join(installed, name))) {
        yield* fs.symlink(
          yield* fs.realPath(path.join(installed, name, pkg)),
          path.join(dependencies, name, pkg),
        );
      }
    } else {
      yield* fs.symlink(
        yield* fs.realPath(path.join(installed, name)),
        path.join(dependencies, name),
      );
    }
  }
  return root;
});

export const buildPortableExample = Effect.fn(function* (
  slug: "nextjs" | "vocs",
  existingRoot?: string,
) {
  const path = yield* Path.Path;
  const root = existingRoot ?? (yield* exampleRoot(slug));
  const target = slug === "nextjs" ? Nextjs.target() : Vocs.target();
  const output = yield* target.build({ root, framework: slug });
  expect(output.distDirectory).toBeDefined();
  expect(output.serverModules?.[0]).toBeDefined();
  return {
    root,
    distDir: output.distDirectory!,
    serverEntry: path.join(
      output.distDirectory!,
      output.serverModules![0]!.name,
    ),
    layout: slug === "nextjs" ? ("next" as const) : ("output" as const),
  };
});

export const bodyContaining = Effect.fn(function* (url: string, text: string) {
  const body = yield* HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (body) => body.includes(text),
    }),
  );
  expect(body).toContain(text);
  return body;
});

export const updatedBodyContaining = Effect.fn(function* (
  url: string,
  text: string,
) {
  const samples = yield* functionTextSamples(url, (body) =>
    body.includes(text),
  );
  for (const body of samples) expect(body).toContain(text);
});
