import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useNativeApi } from "../hooks/useNativeApi";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { preferredTerminalEditor } from "../terminal-links";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
}

function ChatMarkdown({ text, cwd }: ChatMarkdownProps) {
  const api = useNativeApi();
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath || !api) {
          return <a {...props} href={href} target="_blank" rel="noreferrer" />;
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void api.shell.openInEditor(targetPath, preferredTerminalEditor());
            }}
          />
        );
      },
    }),
    [api, cwd],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
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

export default memo(ChatMarkdown);
