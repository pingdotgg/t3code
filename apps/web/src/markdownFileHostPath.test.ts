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
  for (const path of ["./src/file.ts", "/home/user/project/./src/file.ts"]) {
    expect(
      buildWslMarkdownFileUrl({
        editor: "vscode",
        distro: "Ubuntu",
        path,
        cwd: "/home/user/project",
        line: 12,
        column: 3,
      }),
    ).toBe("vscode://vscode-remote/wsl+Ubuntu/home/user/project/src/file.ts:12:3");
  }
  expect(
    buildWslMarkdownFileUrl({
      editor: "vscode",
      distro: "Ubuntu",
      path: "link/../file.ts",
      cwd: "/home/user/project",
      line: 12,
      column: 3,
    }),
  ).toBeUndefined();
  expect(
    buildWslMarkdownFileUrl({
      editor: "vscode",
      distro: "Ubuntu",
      path: "/opt/pkg/file.ts",
      cwd: "/home/user/project",
      line: 12,
      column: 3,
    }),
  ).toBe("vscode://vscode-remote/wsl+Ubuntu/opt/pkg/file.ts:12:3");
});
