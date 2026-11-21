import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";
import {
  Info,
  Lightbulb,
  type LucideIcon,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import { memo, Profiler, type ProfilerOnRenderCallback, useMemo } from "react";
import Markdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import remarkMath from "remark-math";

import { BlockContext } from "./blockContext";
import { isSafeImageSource } from "./imageSource";
import { Details } from "./Details";
import { MarkdownAnchor } from "./MarkdownAnchor";
import { MarkdownCode } from "./MarkdownCode";
import { MarkdownPre } from "./MarkdownPre";
import { withSkillChips } from "./SkillText";
import { Table } from "./Table";
import { MARK_TOKENS } from "./tokenMarks";

interface AlertStyle {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly border: string;
  readonly title: string;
}

const ALERTS = new Map<string, AlertStyle>([
  ["note", { label: "Note", Icon: Info, border: "border-blue-500/70", title: "text-blue-400" }],
  [
    "tip",
    { label: "Tip", Icon: Lightbulb, border: "border-emerald-500/70", title: "text-emerald-400" },
  ],
  [
    "important",
    {
      label: "Important",
      Icon: MessageSquareWarning,
      border: "border-purple-500/70",
      title: "text-purple-400",
    },
  ],
  [
    "warning",
    {
      label: "Warning",
      Icon: TriangleAlert,
      border: "border-amber-500/70",
      title: "text-amber-400",
    },
  ],
  [
    "caution",
    { label: "Caution", Icon: OctagonAlert, border: "border-red-500/70", title: "text-red-400" },
  ],
]);

const components: Components = {
  p: ({ node: _node, children, ...props }) => (
    <p className="my-1.5 first:mt-0 last:mb-0" {...props}>
      {withSkillChips(children)}
    </p>
  ),
  ul: ({ node: _node, ...props }) => <ul className="my-1.5 list-disc pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
  li: ({ node: _node, children, ...props }) => (
    <li className="my-0.5" {...props}>
      {withSkillChips(children)}
    </li>
  ),
  h1: ({ node: _node, ...props }) => (
    <h4 className="mt-3 mb-1 text-[15px] font-semibold" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h4 className="mt-3 mb-1 text-[14px] font-semibold" {...props} />
  ),
  h3: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 font-semibold" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 font-semibold" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-line" {...props} />,
  a: MarkdownAnchor,
  blockquote: ({ node, children, ...props }) => {
    const alert = ALERTS.get(String(node?.properties["dataAlert"] ?? ""));
    if (alert === undefined) {
      return (
        <blockquote className="my-2 border-l-2 border-line pl-3 text-muted" {...props}>
          {children}
        </blockquote>
      );
    }
    return (
      <div role="note" data-markdown-alert className={`my-2 border-l-2 pl-3 ${alert.border}`}>
        <p className={`flex items-center gap-1.5 font-medium ${alert.title}`}>
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  table: ({ node: _node, ...props }) => <Table {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border-b border-line px-2 py-1 text-left align-top font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-line/60 px-2 py-1 align-top" {...props} />
  ),
  details: ({ node: _node, children, open }) => <Details open={open}>{children}</Details>,
  pre: MarkdownPre,
  code: MarkdownCode,
};

const UNTRUSTED_COMPONENTS: Components = {
  ...components,
  img: ({ node: _node, src, alt, ...props }) =>
    isSafeImageSource(src) ? (
      <img src={src} alt={alt} {...props} />
    ) : (
      <span data-blocked-image>{alt}</span>
    ),
};

// A path the engine's machine holds, such as `C:\work\a.png`, reads as a scheme to the default
// transform, which would blank it before the link is classified.
function urlTransform(href: string): string {
  return isWindowsDrivePathHref(href) || href.toLowerCase().startsWith("file:")
    ? href
    : defaultUrlTransform(href);
}

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [...CHAT_MARKDOWN_REMARK_PLUGINS];
const REMARK_PLUGINS_WITH_MATH: NonNullable<Options["remarkPlugins"]> = [
  [remarkMath, { singleDollarTextMath: true }],
  ...CHAT_MARKDOWN_REMARK_PLUGINS,
];
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [...CHAT_MARKDOWN_REHYPE_PLUGINS];

// A formula needs a closing `$` after another `$` on its line and not right after a space, so a
// `$skill` mention and a price skip the math parser.
function mayContainMath(text: string): boolean {
  if (text.includes("\\(") || text.includes("\\[") || /(?:`{3,}|~{3,})[ \t]*math\b/.test(text)) {
    return true;
  }
  let opened = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") opened = false;
    else if (char === "$") {
      if (opened && text[index - 1] !== " ") return true;
      opened = true;
    }
  }
  return false;
}

const markCommit: ProfilerOnRenderCallback = (id, phase, _actual, _base, _start, commitTime) => {
  performance.mark("board:block-commit", { detail: { block: Number(id), phase, commitTime } });
};

/** One markdown block. It re-renders only when its own text changes, so a streaming reply redraws just its last block. */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  streaming,
  index,
  untrusted = false,
}: {
  text: string;
  streaming: boolean;
  index: number;
  untrusted?: boolean;
}) {
  const value = useMemo(() => ({ text, streaming }), [text, streaming]);
  const body = (
    <BlockContext value={value}>
      <Markdown
        remarkPlugins={mayContainMath(text) ? REMARK_PLUGINS_WITH_MATH : REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={untrusted ? UNTRUSTED_COMPONENTS : components}
        urlTransform={urlTransform}
      >
        {text}
      </Markdown>
    </BlockContext>
  );
  return MARK_TOKENS ? (
    <Profiler id={String(index)} onRender={markCommit}>
      {body}
    </Profiler>
  ) : (
    body
  );
});
