import { describe, expect, it } from "vite-plus/test";

import { buildFileBrowserContextMenuItems } from "./fileBrowserContextMenu";

describe("buildFileBrowserContextMenuItems", () => {
  it("offers downloads for files", () => {
    expect(buildFileBrowserContextMenuItems("file")).toContainEqual({
      id: "download",
      label: "Download",
    });
  });

  it("does not offer downloads for directories", () => {
    expect(buildFileBrowserContextMenuItems("directory").map((item) => item.id)).not.toContain(
      "download",
    );
  });
});
