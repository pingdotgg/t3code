import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Toggle, ToggleGroup } from "./toggle-group";

describe("toggle group segmented defaults", () => {
  it("derives the segmented item size from the variant", () => {
    const html = renderToStaticMarkup(
      <ToggleGroup variant="segmented" value={["a"]}>
        <Toggle value="a">A</Toggle>
      </ToggleGroup>,
    );

    expect(html.match(/data-size="segmented"/g)).toHaveLength(2);
    expect(html).toContain("h-6");
    expect(html).toContain("dark:hover:bg-input/32");
    expect(html).toContain("dark:data-pressed:bg-input/72");
  });
});
