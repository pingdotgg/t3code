import { boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import { describe, expect, it } from "vite-plus/test";

import {
  FolderArchiveError,
  buildFolderZip,
  collectFolderEntries,
  collectPickedFolderEntries,
} from "./folderArchive";

type FakeEntry = FakeFileEntry | FakeDirectoryEntry;
interface FakeFileEntry {
  readonly isFile: true;
  readonly isDirectory: false;
  readonly name: string;
  file(success: (file: File) => void): void;
}
interface FakeDirectoryEntry {
  readonly isFile: false;
  readonly isDirectory: true;
  readonly name: string;
  createReader(): { readEntries(success: (entries: FakeEntry[]) => void): void };
}

const fileEntry = (name: string, file: File = new File([name], name)): FakeFileEntry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (success) => success(file),
});

// Pages like Chromium, which hands back at most 100 entries per readEntries call.
const dirEntry = (
  name: string,
  children: FakeEntry[],
  onRead: () => void = () => {},
): FakeDirectoryEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let offset = 0;
    return {
      readEntries: (success) => {
        onRead();
        const batch = children.slice(offset, offset + 100);
        offset += batch.length;
        success(batch);
      },
    };
  },
});

const asRoot = (entry: FakeDirectoryEntry) => entry as unknown as FileSystemDirectoryEntry;

const pickedFile = (relativePath: string, content = relativePath) => {
  const file = new File([content], relativePath.split("/").at(-1)!);
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
};

const manyFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => fileEntry(`f${index}.txt`));

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(FolderArchiveError);
  return (error as FolderArchiveError).message;
}

describe("collectFolderEntries", () => {
  it("walks every page of nested folders and skips .git and node_modules at any depth", async () => {
    const root = dirEntry("src", [
      ...manyFiles(250),
      dirEntry(".git", [fileEntry("HEAD")]),
      dirEntry("output", []),
      dirEntry("lib", [
        fileEntry("index.ts"),
        dirEntry("node_modules", [fileEntry("dep.js")]),
        dirEntry("deep", [dirEntry("node_modules", [fileEntry("x.js")]), fileEntry("leaf.ts")]),
      ]),
    ]);

    const collection = await collectFolderEntries(asRoot(root));

    expect(collection.folderName).toBe("src");
    expect(collection.entries).toHaveLength(252);
    expect(collection.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining([
        "src/f0.txt",
        "src/f249.txt",
        "src/lib/index.ts",
        "src/lib/deep/leaf.ts",
      ]),
    );
    expect(collection.directories.toSorted()).toEqual([
      "src/",
      "src/lib/",
      "src/lib/deep/",
      "src/output/",
    ]);
    expect(collection.skipped).toEqual([
      { name: ".git", count: 1 },
      { name: "node_modules", count: 2 },
    ]);
  });

  it("counts folders toward the entry limit, as the ZIP preview does", async () => {
    // src/ + src/a/ + 2,046 files is exactly 2,048 entries.
    await expect(
      collectFolderEntries(asRoot(dirEntry("src", [dirEntry("a", manyFiles(2046))]))),
    ).resolves.toMatchObject({ folderName: "src" });
    expect(
      await refusal(
        collectFolderEntries(asRoot(dirEntry("src", [dirEntry("a", manyFiles(2047))]))),
      ),
    ).toBe(
      "'src' has more than 2,048 files and folders. Attach a smaller folder or zip it yourself.",
    );
  });

  it("refuses a folder over the uncompressed limit without reading its bytes", async () => {
    const huge = { name: "big.bin", size: 201 * 1024 * 1024 } as File;
    expect(
      await refusal(collectFolderEntries(asRoot(dirEntry("src", [fileEntry("big.bin", huge)])))),
    ).toBe("'src' is larger than 200 MB before compression.");
  });

  it("refuses a folder that is empty once skipped folders are left out", async () => {
    expect(
      await refusal(
        collectFolderEntries(asRoot(dirEntry("src", [dirEntry("node_modules", manyFiles(3))]))),
      ),
    ).toBe("'src' is empty.");
  });

  it("stops walking when aborted", async () => {
    const controller = new AbortController();
    const root = dirEntry("src", manyFiles(300), () => controller.abort());
    await expect(collectFolderEntries(asRoot(root), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("collectPickedFolderEntries", () => {
  it("uses webkitRelativePath and applies the same skip rules", () => {
    const collection = collectPickedFolderEntries([
      pickedFile("src/a.ts"),
      pickedFile("src/lib/b.ts"),
      pickedFile("src/.git/HEAD"),
      pickedFile("src/.git/config"),
      pickedFile("src/lib/node_modules/x/index.js"),
    ]);

    expect(collection.folderName).toBe("src");
    expect(collection.entries.map((entry) => entry.relativePath)).toEqual([
      "src/a.ts",
      "src/lib/b.ts",
    ]);
    expect(collection.skipped).toEqual([
      { name: ".git", count: 1 },
      { name: "node_modules", count: 1 },
    ]);
  });

  it("refuses an empty selection", () => {
    expect(() => collectPickedFolderEntries([pickedFile("src/.git/HEAD")])).toThrow(
      "'src' is empty.",
    );
  });
});

describe("buildFolderZip", () => {
  it("builds <folder>.zip that the preview reader opens with the relative paths intact", async () => {
    const collection = collectPickedFolderEntries([
      pickedFile("src/a.ts", "export const a = 1;"),
      pickedFile("src/lib/b.ts", "export const b = 2;"),
    ]);

    const zip = await buildFolderZip(collection, { maxZipBytes: 50 * 1024 * 1024 });

    expect(zip.name).toBe("src.zip");
    expect(zip.type).toBe("application/zip");
    const files = await boundedZip(await zip.arrayBuffer());
    expect([...files.keys()].toSorted()).toEqual(["src/", "src/a.ts", "src/lib/", "src/lib/b.ts"]);
    expect(new TextDecoder().decode(files.get("src/lib/b.ts")?.bytes)).toBe("export const b = 2;");
  });

  it("refuses a ZIP over the upload limit", async () => {
    const collection = collectPickedFolderEntries([pickedFile("src/a.ts", "x".repeat(2048))]);
    expect(await refusal(buildFolderZip(collection, { maxZipBytes: 10 }))).toMatch(
      /^'src\.zip' is \d+ KB after compression; the limit is 1 KB\.$/,
    );
  });

  it("does not build once aborted", async () => {
    const collection = collectPickedFolderEntries([pickedFile("src/a.ts")]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildFolderZip(collection, { maxZipBytes: 1024, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
