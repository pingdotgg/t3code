import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./components/ChatMarkdown";

const pluginSets = [
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["hard breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const;
const singleTildeMarkdown = "tranche split has drifted to ~$45B senior/~$30-35B junior";

it("covers remark-gfm's default single-tilde behavior", () => {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{singleTildeMarkdown}</ReactMarkdown>,
  );

  expect(html).toContain("<del>$45B senior/</del>");
});

describe.each(pluginSets)("ChatMarkdown %s plugins", (_name, remarkPlugins) => {
  function renderMarkdown(markdown: string): string {
    return renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={remarkPlugins}>{markdown}</ReactMarkdown>,
    );
  }

  it("does not strike through single-tilde pairs", () => {
    expect(renderMarkdown(singleTildeMarkdown)).not.toContain("<del>");
  });

  it("strikes through double-tilde pairs", () => {
    expect(renderMarkdown("~~struck~~")).toContain("<del>struck</del>");
  });
});
