import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { OpenVsxThemeExtension } from "../../openVsxThemes";
import { ThemeImportDialog } from "./ThemeImportDialog";

const searchOpenVsxThemes = vi.hoisted(() => vi.fn());

vi.mock("../../openVsxThemes", () => ({
  searchOpenVsxThemes,
  importOpenVsxThemeExtension: vi.fn(),
}));

const extension: OpenVsxThemeExtension = {
  id: "acme.nightfall",
  collectionId: "acme.nightfall",
  name: "Nightfall",
  publisher: "acme",
  description: "A dark theme",
  downloadCount: 10,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: "https://example.test/manifest",
  sha256Url: "https://example.test/sha256",
  vsixUrl: "https://example.test/vsix",
  version: "1.0.0",
  license: "MIT",
};

describe("ThemeImportDialog", () => {
  // StrictMode replays ref attach/detach on mount, which must not end the session.
  it("searches Open VSX under StrictMode", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([extension]);
    await using _screen = await render(
      <StrictMode>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </StrictMode>,
    );

    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("heading", { name: "Nightfall" })).toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ sortBy: "downloadCount" }),
    );
  });
});
