import * as NodeModule from "node:module";
import type { Result } from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

it.effect("decodes native search and grep strings and keeps scores only through 200 results", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const basePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fff-native-" });
    const names = [
      ...Array.from({ length: 205 }, (_, index) => `file-${String(index).padStart(3, "0")}`),
      "日本語",
      "café",
      "emoji-🦊",
    ];
    const relativePaths = names.map((name) => `${name}/${name}.ts`);
    const content = "prefix marker-日本語🦊\n";
    yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.join(basePath, name));
          yield* fileSystem.writeFileString(path.join(basePath, name, `${name}.ts`), content);
        }),
      { concurrency: "unbounded" },
    );
    expect(requireForFff.resolve("@ff-labs/fff-node").replaceAll("\\", "/")).toMatch(
      /\/dist\/index\.js$/u,
    );
    const finder = yield* Effect.acquireRelease(
      Effect.sync(() =>
        valueOf(FileFinder.create({ basePath, disableWatch: true, disableMmapCache: true })),
      ),
      (finder) => Effect.sync(() => finder.destroy()),
    );
    expect(valueOf(yield* Effect.promise(() => finder.waitForIndexReady(10_000)))).toBe(true);

    const files200 = valueOf(finder.fileSearch("", { pageSize: 200 }));
    const files201 = valueOf(finder.fileSearch("", { pageSize: 201 }));
    expect(files200.items).toHaveLength(200);
    expect(files200.scores).toHaveLength(200);
    expect(files201.items).toHaveLength(201);
    expect(files201.scores).toEqual([]);
    expect(files201.items.slice(0, 200)).toEqual(files200.items);
    const files = valueOf(finder.fileSearch("", { pageSize: 1000 }));
    expect(files.items.map((item) => item.relativePath.normalize("NFC")).toSorted()).toEqual(
      relativePaths.toSorted(),
    );
    for (const item of files.items) {
      expect(item.fileName.normalize("NFC")).toBe(
        path.basename(item.relativePath).normalize("NFC"),
      );
      expect(item.size).toBe(Buffer.byteLength(content));
      expect(Number.isFinite(item.modified)).toBe(true);
    }
    const exact = valueOf(finder.fileSearch("日本語.ts", { pageSize: 1 }));
    expect(exact.items[0]?.fileName.normalize("NFC")).toBe("日本語.ts");
    expect(exact.scores[0]).toMatchObject({ exactMatch: true, matchType: "exact_filename" });

    const dirs200 = valueOf(finder.directorySearch("", { pageSize: 200 }));
    const dirs201 = valueOf(finder.directorySearch("", { pageSize: 201 }));
    expect(dirs200.scores).toHaveLength(200);
    expect(dirs201.items).toHaveLength(201);
    expect(dirs201.scores).toEqual([]);
    expect(dirs201.items.slice(0, 200)).toEqual(dirs200.items);
    const directories = valueOf(finder.directorySearch("", { pageSize: 1000 }));
    expect(
      directories.items
        .map((item) => item.relativePath.normalize("NFC"))
        .filter(Boolean)
        .toSorted(),
    ).toEqual(names.map((name) => `${name}/`).toSorted());

    const mixed200 = valueOf(finder.mixedSearch("", { pageSize: 200 }));
    const mixed201 = valueOf(finder.mixedSearch("", { pageSize: 201 }));
    expect(mixed200.scores).toHaveLength(200);
    expect(mixed201.items).toHaveLength(201);
    expect(mixed201.scores).toEqual([]);
    expect(mixed201.items.slice(0, 200)).toEqual(mixed200.items);
    const mixed = valueOf(finder.mixedSearch("", { pageSize: 1000 }));
    expect(mixed.items.filter((item) => item.type === "file").map(({ item }) => item)).toEqual(
      files.items,
    );
    expect(mixed.items.filter((item) => item.type === "directory").map(({ item }) => item)).toEqual(
      directories.items,
    );

    const grep = valueOf(finder.grep("marker", { mode: "plain", pageSize: 1000 }));
    expect(grep.items.map((item) => item.relativePath.normalize("NFC")).toSorted()).toEqual(
      relativePaths.toSorted(),
    );
    for (const item of grep.items) {
      expect(item.fileName.normalize("NFC")).toBe(
        path.basename(item.relativePath).normalize("NFC"),
      );
      expect(item.lineContent).toBe(content.trimEnd());
      expect(item.lineNumber).toBe(1);
      expect(item.col).toBe(7);
      expect(item.matchRanges).toEqual([[7, 13]]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
