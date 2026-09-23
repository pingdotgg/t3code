import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  openVsxDownload,
  openVsxSha256,
  openVsxUrl,
  parseInstalledExtension,
  rehAsset,
} from "./extensionMetadata.ts";

describe("extension metadata", () => {
  it("uses the supported REH assets and rejects Windows arm64", () => {
    expect(rehAsset("linux", "x64")).toEqual({
      url: "https://github.com/VSCodium/vscodium/releases/download/1.135.06055/vscodium-reh-linux-x64-1.135.06055.tar.gz",
      sha256: "bd23015a35b915bac3c6fca962ca5db427f5c8f049702e48ddeb72757ab32745",
    });
    expect(rehAsset("darwin", "arm64")?.sha256).toBe(
      "f645669f423f88fd2626d88f80d3f931b6c21fda93df4177d19a91c46815be1c",
    );
    expect(rehAsset("darwin", "x64")?.sha256).toBe(
      "dc80d0c01f870c0c2c4d26469ce3c1ce80dd449b227cd8aee88af4fceb0e7453",
    );
    expect(rehAsset("linux", "arm64")?.sha256).toBe(
      "697d2cf622152b3b3affbbd18d48e5ff51e1e2fbf5833ad66262bda413c599c5",
    );
    expect(rehAsset("win32", "x64")?.sha256).toBe(
      "3f7d84ba5b4440e4e328dad4fe182f14bba7333db170485e989ac2c1c49b6a0c",
    );
    expect(rehAsset("win32", "arm64")).toBeNull();
    expect(rehAsset("freebsd", "x64")).toBeNull();
  });

  it("extracts the Open VSX download and verifies its digest", () => {
    const digest = NodeCrypto.createHash("sha256").update("vsix bytes").digest("hex");
    const reference = {
      files: {
        download: "https://open-vsx.org/api/example/extension/1.0/file/example.extension.vsix",
        sha256: "https://open-vsx.org/api/example/extension/1.0/file/example.extension.sha256",
      },
    };
    expect(openVsxUrl("example", "extension", "1.0")).toBe(
      "https://open-vsx.org/api/example/extension/1.0",
    );
    expect(openVsxDownload(reference)).toEqual({
      url: reference.files.download,
      sha256Url: reference.files.sha256,
    });
    expect(openVsxSha256(`${digest}  example.vsix`)).toBe(digest);
    expect(() =>
      openVsxDownload({ files: { ...reference.files, download: "http://evil.test/file" } }),
    ).toThrow();
    expect(() => openVsxSha256("invalid")).toThrow();
  });

  it("reads localized views and commands and flags Microsoft only extensions", () => {
    const manifest = {
      publisher: "ms-python",
      name: "python",
      version: "2026.1.0",
      displayName: "%displayName%",
      description: "%description%",
      icon: "images/icon.png",
      contributes: {
        viewsContainers: {
          activitybar: [{ id: "python", title: "%container%", icon: "images/icon.svg" }],
          panel: [{ id: "python.panel", title: "Output" }],
        },
        views: {
          python: [
            { id: "tree", name: "%tree%" },
            { id: "web", name: "Web", type: "webview" },
          ],
          "python.panel": [{ id: "output", name: "Output" }],
        },
        customEditors: [{ viewType: "python.editor", displayName: "%editor%" }],
        commands: [{ command: "python.run", title: "%command%", category: "Python" }],
      },
    };
    const parsed = parseInstalledExtension(
      manifest,
      {
        displayName: "Python",
        description: "Python tools",
        container: "Python",
        tree: "Projects",
        editor: "Notebook",
        command: "Run",
      },
      false,
    );
    expect(parsed).toMatchObject({
      id: "ms-python.python",
      displayName: "Python",
      description: "Python tools",
      enabled: false,
      microsoftOnly: true,
      viewContainers: [
        {
          id: "python",
          title: "Python",
          icon: "/api/vscode-icons/ms-python.python/images%2Ficon.svg",
          views: [
            { id: "tree", name: "Projects", type: "tree" },
            { id: "web", type: "webview" },
          ],
        },
        { id: "python.panel", views: [{ id: "output", type: "tree" }] },
      ],
      customEditors: [{ viewType: "python.editor", displayName: "Notebook" }],
      commands: [{ command: "python.run", title: "Run", category: "Python" }],
    });
    expect(parsed?.iconUrl).toBe("/api/vscode-icons/ms-python.python");
    expect(
      parseInstalledExtension({ ...manifest, publisher: "example" }, {}, true)?.microsoftOnly,
    ).toBe(false);
    expect(
      parseInstalledExtension(
        { ...manifest, publisher: "example", extensionKind: ["ui"] },
        {},
        true,
      )?.microsoftOnly,
    ).toBe(true);
  });
});
