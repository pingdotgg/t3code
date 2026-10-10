import { expect, it, vi } from "vite-plus/test";

vi.mock("@crowecawcaw/xa11y", () => {
  throw new Error("Cannot find native binding");
});

it("loads without an accessibility native binding", async () => {
  await expect(import("./ElectronWindow.ts")).resolves.toBeDefined();
});
