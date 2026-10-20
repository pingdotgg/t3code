import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fontFixture } from "./mobileFonts.test-fixtures";

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  deleted: [] as string[],
  load: vi.fn(),
  nextId: 0,
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++mocks.nextId).padStart(12, "0")}`,
}));
vi.mock("expo-font", () => ({ isLoaded: () => false, loadAsync: mocks.load }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "document://" },
  Directory: class {
    uri: string;
    constructor(base: string, part: string) {
      this.uri = base + part;
    }
    create() {}
  },
  File: class {
    uri: string;
    constructor(base: string | { uri: string }, file?: string) {
      this.uri = typeof base === "string" ? base : base.uri + "/" + file;
    }
    get size() {
      return mocks.files.get(this.uri)?.length ?? 0;
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    async bytes() {
      const data = mocks.files.get(this.uri);
      if (!data) throw new Error("File missing");
      return data;
    }
    copy(target: { uri: string }) {
      mocks.files.set(target.uri, mocks.files.get(this.uri)!);
    }
    delete() {
      mocks.deleted.push(this.uri);
      mocks.files.delete(this.uri);
    }
  },
}));

import { copyImportedFonts, importFontFiles, loadImportedFontFiles } from "./mobileFontFiles";
import { mergeImportedFonts } from "./mobileFonts";

beforeEach(() => {
  mocks.files.clear();
  mocks.deleted.length = 0;
  mocks.nextId = 0;
  mocks.load.mockReset().mockResolvedValue(undefined);
});

describe("mobile font import files", () => {
  it("imports a new family even when an unrelated stored family is missing", async () => {
    mocks.files.set("cache://old.ttf", fontFixture({ family: "Missing" }));
    const current = await copyImportedFonts([{ uri: "cache://old.ttf", name: "old.ttf" }]);
    mocks.files.delete(`document://custom-fonts/${current[0]!.file}`);
    mocks.files.set("cache://new.ttf", fontFixture({ family: "Readable" }));
    mocks.load.mockImplementation(async (definitions) => {
      if (
        definitions[0].fontDefinitions.some((face: { path: string }) => !mocks.files.has(face.path))
      )
        throw new Error("File missing");
    });
    const save = vi.fn(async (copied) => mergeImportedFonts(current, copied));

    const retained = await importFontFiles(
      [{ uri: "cache://new.ttf", name: "new.ttf" }],
      current,
      save,
    );

    expect(save).toHaveBeenCalledOnce();
    expect(retained.map((face) => face.family)).toEqual(["Missing", "Readable"]);
    expect(mocks.files.has(`document://custom-fonts/${retained[1]!.file}`)).toBe(true);
    expect(mocks.deleted).toEqual([]);
  });
  it("repairs a missing face with a replacement in the same family", async () => {
    mocks.files.set("cache://old.ttf", fontFixture({ family: "Readable" }));
    const current = await copyImportedFonts([{ uri: "cache://old.ttf", name: "old.ttf" }]);
    mocks.files.delete(`document://custom-fonts/${current[0]!.file}`);
    mocks.files.set("cache://replacement.ttf", fontFixture({ family: "Readable" }));
    mocks.load.mockImplementation(async (definitions) => {
      if (
        definitions[0].fontDefinitions.some((face: { path: string }) => !mocks.files.has(face.path))
      )
        throw new Error("File missing");
    });

    const retained = await importFontFiles(
      [{ uri: "cache://replacement.ttf", name: "replacement.ttf" }],
      current,
      async (copied) => mergeImportedFonts(current, copied),
    );

    expect(retained).toHaveLength(1);
    expect(retained[0]!.id).not.toBe(current[0]!.id);
    expect(mocks.files.has(`document://custom-fonts/${retained[0]!.file}`)).toBe(true);
  });
  it("rolls back a new family that fails to load without saving it", async () => {
    mocks.files.set("cache://new.ttf", fontFixture({ family: "Broken" }));
    mocks.load.mockRejectedValue(new Error("Font rejected"));
    const save = vi.fn();

    await expect(
      importFontFiles([{ uri: "cache://new.ttf", name: "new.ttf" }], [], save),
    ).rejects.toThrow("Could not load: Broken");

    expect(save).not.toHaveBeenCalled();
    expect([...mocks.files.keys()]).toEqual(["cache://new.ttf"]);
    expect(mocks.deleted).toHaveLength(1);
  });
  it("keeps existing files when saving a replacement fails", async () => {
    mocks.files.set("cache://old.ttf", fontFixture({ family: "Readable" }));
    const current = await copyImportedFonts([{ uri: "cache://old.ttf", name: "old.ttf" }]);
    mocks.files.set("cache://new.ttf", fontFixture({ family: "Readable" }));

    await expect(
      importFontFiles([{ uri: "cache://new.ttf", name: "new.ttf" }], current, async () => {
        throw new Error("Storage failed");
      }),
    ).rejects.toThrow("Storage failed");

    expect([...mocks.files.keys()].filter((key) => key.startsWith("document://"))).toEqual([
      `document://custom-fonts/${current[0]!.file}`,
    ]);
  });
  it("copies selected fonts into private storage and reads the family from the file", async () => {
    mocks.files.set(
      "cache://misleading-name.ttf",
      fontFixture({ typographicFamily: "Real Family", weight: 600 }),
    );
    const [face] = await copyImportedFonts([
      { uri: "cache://misleading-name.ttf", name: "misleading-name.ttf" },
    ]);
    expect(face).toMatchObject({ family: "Real Family", weight: 600, italic: false });
    expect(mocks.files.get(`document://custom-fonts/${face!.file}`)).toEqual(
      mocks.files.get("cache://misleading-name.ttf"),
    );
    expect(face).not.toHaveProperty("uri");
  });
  it("rolls back copied files if a later selected file is invalid", async () => {
    mocks.files.set("cache://good.ttf", fontFixture());
    mocks.files.set("cache://bad.ttf", new Uint8Array(3));
    await expect(
      copyImportedFonts([
        { uri: "cache://good.ttf", name: "good.ttf" },
        { uri: "cache://bad.ttf", name: "bad.ttf" },
      ]),
    ).rejects.toThrow("incomplete");
    expect([...mocks.files.keys()].filter((key) => key.startsWith("document://"))).toEqual([]);
    expect(mocks.deleted).toHaveLength(1);
  });
  it("loads matching weights and italics together and isolates an unavailable family", async () => {
    mocks.files.set("cache://regular.ttf", fontFixture({ family: "Readable" }));
    mocks.files.set("cache://italic.ttf", fontFixture({ family: "Readable", italic: true }));
    mocks.files.set("cache://missing.ttf", fontFixture({ family: "Unavailable" }));
    const faces = await copyImportedFonts(
      ["regular", "italic", "missing"].map((name) => ({
        uri: `cache://${name}.ttf`,
        name: `${name}.ttf`,
      })),
    );
    const missingFile = faces[2]!.file;
    mocks.load.mockImplementation(async (definitions) => {
      if (
        definitions[0].fontDefinitions.some((face: { path: string }) =>
          face.path.endsWith(missingFile),
        )
      )
        throw new Error("Font failed");
    });
    const result = await loadImportedFontFiles(faces);
    expect(result.loaded.size).toBe(1);
    expect(result.unavailable).toEqual(["Unavailable"]);
    const readable = mocks.load.mock.calls.find(
      ([definitions]) => definitions[0].fontDefinitions.length === 2,
    )![0][0];
    expect(readable.fontDefinitions.map((face: { style: string }) => face.style)).toEqual([
      "normal",
      "italic",
    ]);
  });
});
