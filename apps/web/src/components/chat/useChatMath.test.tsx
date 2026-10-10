// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { expect, it, vi } from "vite-plus/test";
import { useChatMathPlugins } from "./useChatMath";

const imports = vi.hoisted(() => {
  function ready() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }
  return { loaded: vi.fn(), on: ready(), readable: ready() };
});

vi.mock("./markdownMathRendered", () => {
  imports.loaded("on");
  imports.on.resolve();
  return { CHAT_MATH_PLUGINS: { remark: [], rehype: [], literalRehype: [] } };
});
vi.mock("./markdownMathReadable", () => {
  imports.loaded("readable");
  imports.readable.resolve();
  return { CHAT_MATH_PLUGINS: { remark: [], rehype: [], literalRehype: [] } };
});

function Markdown({ mode, text }: { mode: "off" | "on" | "readable"; text: string }) {
  const plugins = useChatMathPlugins(mode, text);
  return (
    <ReactMarkdown
      remarkPlugins={[...CHAT_MARKDOWN_REMARK_PLUGINS, ...(plugins?.remark ?? [])]}
      rehypePlugins={plugins?.rehype ?? CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {text}
    </ReactMarkdown>
  );
}

it("loads math only for delimiters outside code in both active modes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const codeExamples = [
    "Run `echo $$` to print the process ID.",
    "Regex: `\\(x\\)` and `\\[x\\]`.",
    "``code with ` and \\(x\\)``",
    "`multiline\n\\(x\\)\ncode`",
    "```sh\necho $$\n```",
    "~~~regex\n\\(x\\)\n~~~",
    "```math\n\\[x^2\\]\n```",
    "````sh\n```\necho $$\n````",
    "```sh\necho $$",
    "    echo $$\n    \\(x\\)",
    "> ```sh\n> echo $$\n> ```",
    "- example:\n\n  ```sh\n  echo $$\n  ```",
    String.raw`Escaped \\(x\\), \\[x\\], and \$$.`,
    "[example]: /regex/\\(x\\)",
  ];
  try {
    for (const mode of ["off", "on", "readable"] as const) {
      for (const text of codeExamples) {
        await act(async () => root.render(<Markdown mode={mode} text={text} />));
        expect(imports.loaded, `${mode}: ${text}`).not.toHaveBeenCalled();
      }
      await act(async () =>
        root.render(
          <Markdown
            mode={mode}
            text={"<b>Formatted</b> with `echo $$` <script>unsafe()</script>"}
          />,
        ),
      );
      expect(container.querySelector("b")?.textContent).toBe("Formatted");
      expect(container.querySelector("script")).toBeNull();
      expect(imports.loaded).not.toHaveBeenCalled();
    }
    await act(async () =>
      root.render(<Markdown mode="off" text={String.raw`Equation: \(x^2\).`} />),
    );
    expect(imports.loaded).not.toHaveBeenCalled();
    for (const mode of ["on", "readable"] as const) {
      const equation = mode === "on" ? String.raw`\(x^2\)` : "$$\nx^2\n$$";
      const text = codeExamples[0] + "\n\n" + equation;
      await act(async () => root.render(<Markdown mode={mode} text={text} />));
      await act(async () => imports[mode].promise);
      expect(imports.loaded).toHaveBeenCalledWith(mode);
      expect(container.querySelector("code")?.textContent).toBe("echo $$");
    }
    expect(imports.loaded).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
