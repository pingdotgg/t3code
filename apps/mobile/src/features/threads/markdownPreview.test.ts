import { expect, it } from "vite-plus/test";

import { markdownPreviewText } from "./markdownPreview";

it("flattens markdown into one plain line per paragraph, item or code line", () => {
  expect(
    markdownPreviewText(
      "Two **things** matter:\n\n- `queue` drains in [the worker](docs/w.md)\n1. *Speed* wins\n\n```\nCI: 24 min\n```",
    ),
  ).toBe("Two things matter:\n• queue drains in the worker\n1. Speed wins\nCI: 24 min");
});
