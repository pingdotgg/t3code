import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { closeFile, filesViewAtom, openFile, showBoard, showFile, showSurface } from "./filesView";

const readme = { cwd: "/p", path: "README.md" };
const index = { cwd: "/p", path: "src/index.ts" };

describe("the main view's shown tab", () => {
  it("Given a file shown, when a browser tab is shown then a file is shown again, then each step leaves one tab shown", () => {
    const registry = AtomRegistry.make();
    openFile(registry, readme);
    expect(registry.get(filesViewAtom)).toMatchObject({ active: readme, surface: null });

    showSurface(registry, "page");
    expect(registry.get(filesViewAtom)).toMatchObject({ active: null, surface: "page" });

    showFile(registry, readme);
    expect(registry.get(filesViewAtom)).toMatchObject({ active: readme, surface: null });
  });

  it("Given a browser tab shown, when a file closes then the browser tab stays shown, and the board's tab returns the canvas with the files still open", () => {
    const registry = AtomRegistry.make();
    openFile(registry, readme);
    openFile(registry, index);
    showSurface(registry, "agents");
    closeFile(registry, readme);
    expect(registry.get(filesViewAtom)).toMatchObject({
      tabs: [index],
      active: null,
      surface: "agents",
    });

    showBoard(registry);
    expect(registry.get(filesViewAtom)).toMatchObject({
      tabs: [index],
      active: null,
      surface: null,
    });
  });
});
