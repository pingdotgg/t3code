import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-1.5 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
  li: (props) => <li className="my-0.5" {...props} />,
  h1: (props) => <h4 className="mt-3 mb-1 text-[15px] font-semibold" {...props} />,
  h2: (props) => <h4 className="mt-3 mb-1 text-[14px] font-semibold" {...props} />,
  h3: (props) => <h4 className="mt-2 mb-1 font-semibold" {...props} />,
  h4: (props) => <h4 className="mt-2 mb-1 font-semibold" {...props} />,
  a: (props) => (
    <a
      className="text-focus underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  // A fenced block is a `pre` holding a `code`; an inline code has no `pre` around it.
  pre: (props) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border border-line bg-bg p-2.5 text-[12px] leading-5"
      {...props}
    />
  ),
  code: ({ className, ...props }) => (
    <code
      className={`rounded bg-hover px-1 py-px font-mono text-[12px] [pre_&]:bg-transparent [pre_&]:p-0 ${className ?? ""}`}
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[12px]" {...props} />
    </div>
  ),
  th: (props) => <th className="border border-line px-2 py-1 text-left font-semibold" {...props} />,
  td: (props) => <td className="border border-line px-2 py-1" {...props} />,
  blockquote: (props) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-muted" {...props} />
  ),
};

/** Chat text as T3's web renders it: plain on the panel, with the code and tables styled. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  );
});
