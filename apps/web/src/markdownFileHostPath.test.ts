import { expect, it } from "vite-plus/test";
import { buildWslMarkdownFileUrl } from "./markdownFileHostPath";

it("opens a relative WSL file at its specified position", () => {
  expect(
    buildWslMarkdownFileUrl({
      editor: "vscode",
      distro: "Ubuntu",
      path: "src/file.ts",
      cwd: "/home/user/project",
      line: 12,
      column: 3,
    }),
  ).toBe("vscode://vscode-remote/wsl+Ubuntu/home/user/project/src/file.ts:12:3");
});
