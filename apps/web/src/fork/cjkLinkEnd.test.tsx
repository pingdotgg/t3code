import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "../components/chat/markdownRenderer";
import { remarkEndLinksAtCjkPunctuation } from "./cjkLinkEnd";
import { remarkWhiteboardLinks } from "./whiteboard/markdown-whiteboard";

const render = createMarkdownRenderer({
  remarkPlugins: [
    ...CHAT_MARKDOWN_REMARK_PLUGINS,
    remarkWhiteboardLinks,
    remarkEndLinksAtCjkPunctuation,
  ],
  rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
  components: {},
  urlTransform: (url) => url,
});

function anchors(source: string) {
  const markup = renderToStaticMarkup(render(source));
  return Array.from(markup.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g), ([, href, text]) => ({
    href,
    text,
  }));
}

const bare = (href: string, text = href) => ({ href: encodeURI(href), text });

describe("remarkEndLinksAtCjkPunctuation", () => {
  it.each([
    ["（https://example.com/pull/78），Claude 和", [bare("https://example.com/pull/78")]],
    [
      "补的测试已合并（https://example.com/t3code/pull/78），Claude 和 Codex 都覆盖到了。",
      [bare("https://example.com/t3code/pull/78")],
    ],
    [
      "tools 的 #109（https://example.com/tools/pull/109）修的是 lint",
      [bare("https://example.com/tools/pull/109")],
    ],
    ["见 www.example.com/a。下一句", [bare("http://www.example.com/a", "www.example.com/a")]],
    [
      "两个：https://example.com/a、https://example.com/b；完",
      [bare("https://example.com/a"), bare("https://example.com/b")],
    ],
    ["（see https://example.com/a)，然后", [bare("https://example.com/a")]],
    ['"https://example.com/a"，然后', [bare("https://example.com/a")]],
    [
      "https://example.com/a，另见https://example.com/b，又见https://example.com/c",
      ["a", "b", "c"].map((path) => bare(`https://example.com/${path}`)),
    ],
    [
      "https://example.com/a，另见https://example.com/b?u=https://example.com/c",
      [bare("https://example.com/a"), bare("https://example.com/b?u=https://example.com/c")],
    ],
    ["https://example.com/a，见xhttps://example.com/b", [bare("https://example.com/a")]],
    ["https://example.com/a，见www.example.com/b", [bare("https://example.com/a")]],
    [
      "「https://example.com/a」『https://example.com/b』【https://example.com/c】《https://example.com/d》",
      ["a", "b", "c", "d"].map((path) => bare(`https://example.com/${path}`)),
    ],
    [
      "好！https://example.com/a！真的？https://example.com/b？",
      [bare("https://example.com/a"), bare("https://example.com/b")],
    ],
    ["看 https://example.com/a\u{3000}下一句", [bare("https://example.com/a")]],
    ["看 board://r/1,2,3,4），好", [bare("board://r/1,2,3,4")]],
    ["见 https://example.com/pull/78（已合并）。", [bare("https://example.com/pull/78")]],
    [
      "见 https://example.com/wiki/苹果（消歧义），然后",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
    [
      "（https://example.com/wiki/苹果（消歧义）），然后",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
  ])("ends the bare link at CJK punctuation in %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });

  it.each([...`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`, "&amp;"])(
    "ends a link after %j at CJK punctuation as GFM ends it at a space",
    (trail) => {
      const link = `https://example.com/a${trail}`;
      expect(anchors(`见 ${link}，然后`)).toEqual(anchors(`见 ${link} 然后`));
    },
  );

  it.each([
    ["见 https://example.com/wiki/中文 页", [bare("https://example.com/wiki/中文")]],
    [
      "见 https://example.com/wiki/苹果（消歧义）",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
    ["(see https://example.com/a), then", [bare("https://example.com/a")]],
    [
      "see https://example.com/a_(b) and https://example.com/c.",
      [bare("https://example.com/a_(b)"), bare("https://example.com/c")],
    ],
    ["<https://example.com/a），b>", [bare("https://example.com/a），b")]],
    ["[链接](https://example.com/a)，然后", [bare("https://example.com/a", "链接")]],
  ])("leaves links that need no CJK ending as they were: %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });

  // Upstream's CJK autolink pass ends these first. The first two differ from GFM at a space.
  it.each([
    ["[https://example.com/a]，然后", [bare("https://example.com/a]")]],
    [
      "https://example.com/a，www.example.com/b?u=https://example.com/c",
      [
        bare("https://example.com/a"),
        bare("http://www.example.com/b?u=", "www.example.com/b?u="),
        bare("https://example.com/c"),
      ],
    ],
    ["见 https://example.com/report（1）.pdf 页", [bare("https://example.com/report")]],
  ])("keeps upstream's ending of %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });
});
