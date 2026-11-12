import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = new Map<string, { text: string; deleted: boolean }>();
const failMode = vi.hoisted(() => ({
  current: "none" as "none" | "write" | "move",
  cleanupFails: false,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;
    readonly name: string;
    readonly parentDirectory: { readonly uri: string };

    constructor(parent: string | { readonly uri: string }, name?: string) {
      const parentUri = typeof parent === "string" ? parent : parent.uri;
      this.uri = name ? `${parentUri}/${name}` : parentUri;
      this.name = name ?? this.uri.split("/").at(-1) ?? "file";
      this.parentDirectory = { uri: parentUri };
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    create(): void {
      files.set(this.uri, { text: "", deleted: false });
    }

    async write(text: string): Promise<void> {
      await Promise.resolve(); // Exercise asynchronous file-write rejection.
      if (failMode.current === "write") throw new Error("disk full");
      files.set(this.uri, { text, deleted: false });
    }

    moveSync(destination: { readonly uri: string }): void {
      if (failMode.current === "move") throw new Error("rename failed");
      const entry = files.get(this.uri);
      if (!entry) throw new Error("missing staged file");
      files.set(destination.uri, entry);
      files.delete(this.uri);
    }

    delete(): void {
      if (failMode.cleanupFails) throw new Error("cleanup failed");
      if (!files.has(this.uri)) throw new Error("missing file");
      files.delete(this.uri);
    }
  },
}));

import { writeFileAtomically } from "./atomic-file";
import { File as ExpoFile } from "expo-file-system";

const DIRECTORY_URI = "file:///documents/thread-outbox";

function tempFileUris(): Array<string> {
  return [...files.keys()].filter(
    (uri) => uri.startsWith(`${DIRECTORY_URI}/`) && uri.endsWith(".tmp"),
  );
}

function makeFile(name: string): ExpoFile {
  return new ExpoFile(DIRECTORY_URI, name);
}

describe("writeFileAtomically", () => {
  beforeEach(() => {
    files.clear();
    failMode.current = "none";
    failMode.cleanupFails = false;
  });

  it("lands contents at the final path and leaves no temp file behind", async () => {
    const file = makeFile("message.json");
    await writeFileAtomically(file, '{"ok":true}');
    expect(files.get(file.uri)?.text).toBe('{"ok":true}');
    expect(tempFileUris()).toEqual([]);
  });

  it("removes its staging file when the write fails", async () => {
    failMode.current = "write";
    const file = makeFile("message.json");
    await expect(writeFileAtomically(file, '{"ok":true}')).rejects.toThrow("disk full");
    expect(tempFileUris()).toEqual([]);
  });

  it("removes its staging file when the rename fails", async () => {
    failMode.current = "move";
    const file = makeFile("message.json");
    await expect(writeFileAtomically(file, '{"ok":true}')).rejects.toThrow("rename failed");
    expect(tempFileUris()).toEqual([]);
    expect(files.has(file.uri)).toBe(false);
  });

  it("preserves the original error when cleanup also fails", async () => {
    failMode.current = "write";
    failMode.cleanupFails = true;
    const file = makeFile("message.json");
    await expect(writeFileAtomically(file, "{}")).rejects.toThrow("disk full");
  });
});
