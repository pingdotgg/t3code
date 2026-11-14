import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fileSystemMocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  let failNextWrite = false;
  let failRelocationTo = "";
  let snapshots: Map<string, string>[] | undefined;
  const record = () => snapshots?.push(new Map(files));

  class File {
    name: string;
    readonly parentDirectory: Directory;
    readonly contents: string;

    constructor(parent: string | Directory, nameOrContents: string) {
      this.name = typeof parent === "string" ? parent : nameOrContents;
      this.parentDirectory = typeof parent === "string" ? new Directory() : parent;
      this.contents = typeof parent === "string" ? nameOrContents : "";
    }

    get exists(): boolean {
      return files.has(this.name);
    }

    create(): void {
      files.set(this.name, "");
      record();
    }

    async write(contents: string): Promise<void> {
      files.set(this.name, contents.slice(0, 1));
      record();
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("interrupted write");
      }
      files.set(this.name, contents);
      record();
    }

    copySync(destination: File): void {
      files.delete(destination.name);
      record();
      files.set(destination.name, files.get(this.name)!.slice(0, 1));
      record();
      if (destination.name.endsWith(failRelocationTo) && failRelocationTo) {
        failRelocationTo = "";
        throw new Error("copy failed after partial destination write");
      }
      files.set(destination.name, files.get(this.name)!);
      record();
    }

    moveSync(destination: File): void {
      // Expo removes the destination before attempting the native move.
      files.delete(destination.name);
      record();
      if (destination.name.endsWith(failRelocationTo) && failRelocationTo) {
        failRelocationTo = "";
        throw new Error("move failed after destination removal");
      }
      // Android can fall back to copy-and-delete after native moves fail.
      files.set(destination.name, files.get(this.name)!.slice(0, 1));
      record();
      if (failRelocationTo === "partial") {
        failRelocationTo = "";
        throw new Error("move failed during fallback copy");
      }
      files.set(destination.name, files.get(this.name)!);
      files.delete(this.name);
      this.name = destination.name;
      record();
    }

    delete(): void {
      files.delete(this.name);
      record();
    }

    async text(): Promise<string> {
      return files.get(this.name)!;
    }
  }

  class Directory {
    create(): void {}

    list(): ReadonlyArray<File> {
      return [...files].map(([name, contents]) => new File(name, contents));
    }
  }

  return {
    Directory,
    File,
    failNextWrite() {
      failNextWrite = true;
    },
    failRelocationTo(suffix: string) {
      failRelocationTo = suffix;
    },
    trackOperations() {
      snapshots = [];
      return snapshots;
    },
    setEntries(next: File[]) {
      files.clear();
      for (const file of next) {
        files.set(file.name, file.contents);
      }
      failNextWrite = false;
      failRelocationTo = "";
      snapshots = undefined;
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: fileSystemMocks.Directory,
  File: fileSystemMocks.File,
  Paths: { document: "/documents" },
}));

import {
  IncomingShareStorageError,
  loadIncomingShareDrafts,
  removeIncomingShareDraft,
  writeIncomingShareDraft,
} from "./incoming-share-storage";

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

  it.each(["write", "partial"])("retries an interrupted initial %s", async (failure) => {
    if (failure === "write") fileSystemMocks.failNextWrite();
    else fileSystemMocks.failRelocationTo(failure);

    await expect(writeIncomingShareDraft(VALID_DRAFT)).rejects.toMatchObject({
      operation: "write",
      shareId: VALID_DRAFT.id,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(loadIncomingShareDrafts()).resolves.toEqual([]);

    await writeIncomingShareDraft(VALID_DRAFT);
    await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([VALID_DRAFT]);
  });

  it("preserves a saved share when its reservation write fails and allows retrying", async () => {
    await writeIncomingShareDraft(VALID_DRAFT);
    const reserved = {
      ...VALID_DRAFT,
      destination: { environmentId: "env-1", projectId: "project-1" },
    };
    fileSystemMocks.failNextWrite();

    await expect(writeIncomingShareDraft(reserved)).rejects.toBeInstanceOf(
      IncomingShareStorageError,
    );
    await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([VALID_DRAFT]);

    await writeIncomingShareDraft(reserved);
    await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([reserved]);
  });

  it("removes staging and backup files after a successful replacement", async () => {
    await writeIncomingShareDraft(VALID_DRAFT);
    const updated = { ...VALID_DRAFT, text: "Updated" };

    await writeIncomingShareDraft(updated);

    expect(new fileSystemMocks.Directory().list().map((file) => file.name)).toEqual([
      `${VALID_DRAFT.id}.json`,
    ]);
    await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([updated]);
  });

  it("keeps a successful replacement when backup cleanup fails", async () => {
    await writeIncomingShareDraft(VALID_DRAFT);
    const updated = { ...VALID_DRAFT, text: "Updated" };
    vi.spyOn(fileSystemMocks.File.prototype, "delete").mockImplementationOnce(() => {
      throw new Error("backup cleanup failed");
    });

    await expect(writeIncomingShareDraft(updated)).resolves.toBeUndefined();

    expect(new fileSystemMocks.File(`${VALID_DRAFT.id}.json.bak`, "").exists).toBe(true);
    expect(new fileSystemMocks.File(`${VALID_DRAFT.id}.json.tmp`, "").exists).toBe(false);
    await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([updated]);
  });

  it.each([".bak", ".json", "partial"])(
    "recovers after a failed replacement of %s",
    async (suffix) => {
      await writeIncomingShareDraft(VALID_DRAFT);
      fileSystemMocks.failRelocationTo(suffix);

      await expect(
        writeIncomingShareDraft({ ...VALID_DRAFT, text: "Updated" }),
      ).rejects.toBeInstanceOf(IncomingShareStorageError);
      await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([VALID_DRAFT]);

      // A second failed write must not damage a backup left by the failed move.
      fileSystemMocks.failNextWrite();
      await expect(writeIncomingShareDraft(VALID_DRAFT)).rejects.toBeInstanceOf(
        IncomingShareStorageError,
      );
      await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([VALID_DRAFT]);
      fileSystemMocks.failRelocationTo(".json");
      await expect(writeIncomingShareDraft(VALID_DRAFT)).rejects.toBeInstanceOf(
        IncomingShareStorageError,
      );
      await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([VALID_DRAFT]);
      await writeIncomingShareDraft(VALID_DRAFT);
      await removeIncomingShareDraft(VALID_DRAFT.id);
      await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([]);
    },
  );

  it("loads one complete share after interruption at each replacement operation", async () => {
    await writeIncomingShareDraft(VALID_DRAFT);
    const updated = { ...VALID_DRAFT, text: "Updated" };
    const snapshots = fileSystemMocks.trackOperations();
    await writeIncomingShareDraft(updated);

    for (const snapshot of snapshots) {
      fileSystemMocks.setEntries(
        [...snapshot].map(([name, contents]) => new fileSystemMocks.File(name, contents)),
      );
      const loaded = await loadIncomingShareDrafts({ strict: true });
      expect(loaded).toHaveLength(1);
      expect([VALID_DRAFT, updated]).toContainEqual(loaded[0]);
      await removeIncomingShareDraft(VALID_DRAFT.id);
      await expect(loadIncomingShareDrafts({ strict: true })).resolves.toEqual([]);
    }
    expect(snapshots.length).toBeGreaterThan(0);
  });
});
