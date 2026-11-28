import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { wordsHast } from "../../markdown/wordsHast";
import "../../index.css";

const renderMarkdown = (markdown: string): ReactElement =>
  toJsxRuntime(
    wordsHast(markdown, {
      math: false,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions: {},
    }),
    { Fragment, jsx, jsxs },
  ) as ReactElement;

const prose =
  "这是一个很长的中文说明栏目，用来描述这一行的含义，它应该在窄栏里优雅地换行，不需要频繁地断开。";
const longCode = "contract_number_sequences_and_other_long_identifier_names_here_x";
const table = Array.from({ length: 4 }, () => `| ${prose} | \`${longCode}\` |`).join("\n");
const markdown = `| label | value |\n| --- | --- |\n${table}`;

// The pre-fix layout capped cells at 24rem and gave an unbroken token its min-content width.
const BEFORE_STYLE = `[data-before-table] :is(td,th){max-width:24rem!important}
[data-before-table] [data-markdown-wrap-anywhere]{overflow-wrap:normal!important}`;

it("gives the prose column its width beside a long inline code token", async () => {
  await using screen = await render(
    <>
      <style>{BEFORE_STYLE}</style>
      <div className="chat-markdown" data-before-table="" style={{ width: 720 }}>
        {renderMarkdown(markdown)}
      </div>
      <div className="chat-markdown" style={{ width: 720 }}>
        {renderMarkdown(markdown)}
      </div>
    </>,
  );
  const [before, after] = screen.container.querySelectorAll<HTMLElement>(".chat-markdown");
  const measure = (lane: HTMLElement) => {
    const cells = lane.querySelectorAll("td");
    const table = lane.querySelector("table")!;
    return {
      prose: cells[0]!.getBoundingClientRect().width,
      code: cells[1]!.getBoundingClientRect().width,
      height: table.getBoundingClientRect().height,
      overflow: table.scrollWidth - lane.clientWidth,
    };
  };
  const oldLayout = measure(before!);
  const newLayout = measure(after!);

  expect(newLayout.prose).toBeGreaterThan(oldLayout.prose);
  expect(newLayout.code).toBeLessThan(oldLayout.code);
  expect(newLayout.height).toBeLessThan(oldLayout.height);
  // A few subpixel cells of rounding remain; the old layout ran well past the lane.
  expect(newLayout.overflow).toBeLessThan(oldLayout.overflow / 10);
  expect(after!.querySelector("[data-markdown-wrap-anywhere]")!.textContent).toBe(longCode);
});

it("keeps a very long path inside the lane", async () => {
  const path = `src/${"very/long/path/segment/".repeat(12)}file.ts`;
  await using screen = await render(
    <div className="chat-markdown" style={{ width: 720 }}>
      {renderMarkdown(`| label | value |\n| --- | --- |\n| Status | ${path} |`)}
    </div>,
  );
  const table = screen.container.querySelector("table")!;
  const lane = screen.container.firstElementChild as HTMLElement;
  expect(table.scrollWidth).toBeLessThanOrEqual(lane.clientWidth);
});

it("keeps short code whole", async () => {
  await using screen = await render(
    <div className="chat-markdown" style={{ width: 720 }}>
      {renderMarkdown("| label | value |\n| --- | --- |\n| Status | `fix/table` |")}
    </div>,
  );
  const code = screen.container.querySelector("code")!;
  expect(code.querySelector("[data-markdown-wrap-anywhere]")).toBeNull();
  expect(code.getBoundingClientRect().height).toBeLessThan(24);
});
