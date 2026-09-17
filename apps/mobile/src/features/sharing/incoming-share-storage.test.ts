import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fileSystemMocks = vi.hoisted(() => {
  let entries: File[] = [];

  class File {
    readonly exists = true;

    constructor(
      readonly name: string,
      private readonly contents: string,
    ) {}

    async text(): Promise<string> {
      return this.contents;
    }
  }

  class Directory {
    create(): void {}

    list(): ReadonlyArray<File> {
      return entries;
    }
  }

  return {
    Directory,
    File,
    setEntries(next: File[]) {
      entries = next;
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: fileSystemMocks.Directory,
  File: fileSystemMocks.File,
  Paths: { document: "/documents" },
}));

import { IncomingShareStorageError, loadIncomingShareDrafts } from "./incoming-share-storage";

const VALID_DRAFT = {
  schemaVersion: 1,
  id: "share-valid",
  createdAt: "2026-08-28T12:00:00.000Z",
  text: "Review this file",
  attachments: [],
  warnings: [],
} as const;

afterEach(() => {
  fileSystemMocks.setEntries([]);
  vi.restoreAllMocks();
});

describe("incoming share storage", () => {
  it("skips an invalid persisted share by default", async () => {
    fileSystemMocks.setEntries([
      new fileSystemMocks.File("valid.json", JSON.stringify(VALID_DRAFT)),
      new fileSystemMocks.File("invalid.json", "{"),
    ]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadIncomingShareDrafts()).resolves.toEqual([VALID_DRAFT]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("rejects an invalid persisted share in strict mode", async () => {
    fileSystemMocks.setEntries([new fileSystemMocks.File("invalid.json", "{")]);

    await expect(loadIncomingShareDrafts({ strict: true })).rejects.toBeInstanceOf(
      IncomingShareStorageError,
    );
  });
});
