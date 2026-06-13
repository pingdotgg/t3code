import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import mainSource from "./main.tsx?raw";

describe("React Grab runtime boundary", () => {
  it("keeps the host renderer free of the React Grab overlay", () => {
    expect(mainSource).not.toMatch(/import\(["']react-grab["']\)/);
    expect(packageJson.dependencies).not.toHaveProperty("react-grab");
    expect(packageJson.devDependencies).not.toHaveProperty("react-grab");
  });
});
