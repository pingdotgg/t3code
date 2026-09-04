import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkStandaloneMediaLinks } from "./markdown-media-links";

function renderMarkdown(
  markdown: string,
  options?: { lineBreaks?: boolean; embedLocalPaths?: boolean; workspaceRoot?: string | null },
): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        ...(options?.lineBreaks ? [remarkBreaks] : []),
        [
          remarkStandaloneMediaLinks,
          {
            embedLocalPaths: options?.embedLocalPaths ?? true,
            workspaceRoot:
              options?.workspaceRoot === undefined ? "/workspace" : options.workspaceRoot,
          },
        ],
      ]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remarkStandaloneMediaLinks", () => {
  it.each([
    ["[shot.png](https://cdn.example.com/shot.png)", "https://cdn.example.com/shot.png"],
    [
      "[Recording](https://cdn.example.com/clip.mp4?sig=1)",
      "https://cdn.example.com/clip.mp4?sig=1",
    ],
    [
      "  [**Login** page](<https://cdn.example.com/login page.png>)  ",
      "https://cdn.example.com/login%20page.png",
    ],
  ])("embeds %s", (markdown, src) => {
    const html = renderMarkdown(markdown);

    expect(html).toContain(`<img src="${src}"`);
    expect(html).not.toContain("<a ");
  });

  it("embeds a bare URL without repeating it as alt text", () => {
    const html = renderMarkdown("https://cdn.example.com/shot.png");

    expect(html).toContain('<img src="https://cdn.example.com/shot.png" alt=""');
  });

  it("embeds every link in a run of consecutive lines", () => {
    const html = renderMarkdown(
      ["[a.png](https://cdn.example.com/a.png)", "[b.png](https://cdn.example.com/b.png)"].join(
        "\n",
      ),
    );

    expect(html).toContain(
      '<img src="https://cdn.example.com/a.png" alt="a.png"/><br/>\n<img src="https://cdn.example.com/b.png" alt="b.png"/>',
    );
    expect(html).not.toContain("<a ");
  });

  it("keeps the alt text of an image used as the link label", () => {
    const html = renderMarkdown(
      "[![Login page](https://cdn.example.com/thumb.png)](https://cdn.example.com/login.png)",
    );

    expect(html).toContain('<img src="https://cdn.example.com/login.png" alt="Login page"');
  });

  it("uses the link text as the alt text and keeps the title", () => {
    const html = renderMarkdown('[Login page](https://cdn.example.com/login.png "After sign-in")');

    expect(html).toContain('alt="Login page"');
    expect(html).toContain('title="After sign-in"');
  });

  it.each([false, true])(
    "embeds a link on its own line inside a paragraph (lineBreaks=%s)",
    (lineBreaks) => {
      const html = renderMarkdown(
        [
          "Here is the result:",
          "[shot.png](https://cdn.example.com/shot.png)",
          "See [detail.png](https://cdn.example.com/detail.png) for details.",
        ].join("\n"),
        { lineBreaks },
      );

      expect(html).toContain(
        'Here is the result:<br/>\n<img src="https://cdn.example.com/shot.png" alt="shot.png"/><br/>\nSee ',
      );
      expect(html).toContain('<a href="https://cdn.example.com/detail.png">detail.png</a>');
    },
  );

  it("keeps path links when the surface cannot load local files", () => {
    const html = renderMarkdown(
      ["[shot.png](/tmp/shot.png)", "", "[clip.mp4](https://cdn.example.com/clip.mp4)"].join("\n"),
      { embedLocalPaths: false },
    );

    expect(html).toContain('<a href="/tmp/shot.png">shot.png</a>');
    expect(html).toContain('<img src="https://cdn.example.com/clip.mp4"');
  });

  it("keeps a path link the image renderer could not load", () => {
    expect(renderMarkdown("[shot.png](~/Downloads/shot.png)")).toContain(
      '<a href="~/Downloads/shot.png">shot.png</a>',
    );
    expect(renderMarkdown("[shot.png](docs/shot.png)", { workspaceRoot: null })).toContain(
      '<a href="docs/shot.png">shot.png</a>',
    );
    expect(renderMarkdown("[shot.png](docs/shot.png)")).toContain('<img src="docs/shot.png"');
  });

  it("keeps links in list items and quotes", () => {
    const html = renderMarkdown(
      [
        "- [item.png](https://cdn.example.com/item.png)",
        "",
        "> [quote.png](https://cdn.example.com/quote.png)",
      ].join("\n"),
    );

    expect(html).toContain('<a href="https://cdn.example.com/item.png">item.png</a>');
    expect(html).toContain('<a href="https://cdn.example.com/quote.png">quote.png</a>');
    expect(html).not.toContain("<img");
  });

  it.each([
    "[report](https://cdn.example.com/report.pdf)",
    "[docs](https://example.com/docs)",
    "[shot.png](vscode://file/tmp/shot.png)",
    "[a.png](https://cdn.example.com/a.png) [b.png](https://cdn.example.com/b.png)",
  ])("keeps %s a link", (markdown) => {
    const html = renderMarkdown(markdown);

    expect(html).toContain("<a href=");
    expect(html).not.toContain("<img");
  });

  it("leaves code untouched", () => {
    const html = renderMarkdown(
      ["```md", "[shot.png](https://cdn.example.com/shot.png)", "```"].join("\n"),
    );

    expect(html).toContain("<code");
    expect(html).not.toContain("<img");
  });
});
