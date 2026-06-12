// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };

describe("React Grab runtime boundary", () => {
  it("keeps the host renderer free of the React Grab overlay", () => {
    const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

    expect(mainSource).not.toMatch(/import\(["']react-grab["']\)/);
    expect(packageJson.dependencies).not.toHaveProperty("react-grab");
    expect(packageJson.devDependencies).not.toHaveProperty("react-grab");
  });
});
