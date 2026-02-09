import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

interface ChatMarkdownProps {
  text: string;
}

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
};

export default function ChatMarkdown({ text }: ChatMarkdownProps) {
  return (
    <div className="chat-markdown text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
