import { describe, expect, it } from "@effect/vitest";

import { droppedFolders, pickedFolder } from "./pluginFolders";

const file = (name: string, text: string) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (resolve: (file: File) => void) => resolve(new File([text], name)),
});

// Hands out entries 2 at a time, like Chromium does 100 at a time.
const folder = (name: string, entries: ReadonlyArray<object>) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let next = 0;
    return {
      readEntries: (resolve: (entries: ReadonlyArray<object>) => void) => {
        resolve(entries.slice(next, next + 2));
        next += 2;
      },
    };
  },
});

const drop = (entry: object) =>
  droppedFolders({
    items: [{ kind: "file", webkitGetAsEntry: () => entry }],
  } as unknown as DataTransfer)[0]!;

const picked = (path: string, text: string) =>
  Object.defineProperty(new File([text], path.split("/").at(-1)!), "webkitRelativePath", {
    value: path,
  });

describe("plugin folders", () => {
  it("reads every batch of every dropped folder and leaves out git history and dependencies", async () => {
    const files = await drop(
      folder("surface", [
        file("t3-plugin.json", "{}"),
        file("web.js", "draw()"),
        folder("themes", [file("a.json", "a"), file("b.json", "b"), file("c.json", "c")]),
        folder(".git", [file("HEAD", "ref")]),
        folder("node_modules", [folder("react", [file("index.js", "react")])]),
      ]),
    ).read();
    expect(files.map((entry) => entry.path)).toEqual([
      "t3-plugin.json",
      "web.js",
      "themes/a.json",
      "themes/b.json",
      "themes/c.json",
    ]);
    expect(await files[1]?.file.text()).toBe("draw()");
  });

  it("names a picked folder's files from inside it", async () => {
    const folder = pickedFolder([
      picked("surface/t3-plugin.json", "{}"),
      picked("surface/themes/dark.json", "dark"),
      picked("surface/.git/HEAD", "ref"),
      picked("surface/node_modules/react/index.js", "react"),
    ]);
    expect(folder?.name).toBe("surface");
    expect((await folder!.read()).map((entry) => entry.path)).toEqual([
      "t3-plugin.json",
      "themes/dark.json",
    ]);
  });

  it("refuses a folder that is not a plugin", async () => {
    await expect(
      drop(folder("photos", [file("a.png", ""), folder("2024", [])])).read(),
    ).rejects.toThrow("photos has no t3-plugin.json");
    await expect(pickedFolder([picked("photos/a.png", "")])!.read()).rejects.toThrow(
      "photos has no t3-plugin.json",
    );
  });
});
