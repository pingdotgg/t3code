import { parseClaudeContextReport } from "@t3tools/shared/claudeContextReport";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => [true, () => {}],
}));
vi.mock("react-native", () => ({ View: "div", Pressable: "button" }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));

import { ClaudeContextCardBody } from "./ClaudeContextCard";

it("keeps each expanded section value with its column label and order", () => {
  const report = parseClaudeContextReport(`## Context Usage
**Tokens:** 1k / 200k (0.5%)
### Plugins
| Plugin | Size | Notes |
|---|---|---|
| foo | 1.2k | new column |
`)!;
  const markup = renderToStaticMarkup(<ClaudeContextCardBody report={report} />);
  expect(markup).toContain("Plugin: foo · Size: 1.2k");
  expect(markup).toContain("Notes: new column");
  expect(markup.indexOf("Plugin: foo")).toBeLessThan(markup.indexOf("Notes: new column"));
});
