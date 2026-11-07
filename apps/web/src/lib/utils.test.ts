import { describe, expect, it } from "vite-plus/test";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a background color next to a composer seam background image", () => {
    // oxlint-disable-next-line shadcn/no-raw-colors -- This tests merging an upstream background-image utility, not a theme color.
    expect(cn("dark:before:bg-transparent dark:before:bg-composer-seam-below")).toBe(
      "dark:before:bg-transparent dark:before:bg-composer-seam-below",
    );
  });
});
