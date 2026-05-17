import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeJiraHtml } from "./t3work-ticketRichContentUtils";

export function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="chat-markdown text-sm leading-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function HtmlBlock({ content, baseUrl }: { content: string; baseUrl?: string }) {
  const sanitized = useMemo(() => sanitizeJiraHtml(content, baseUrl), [baseUrl, content]);
  return (
    <div
      className="chat-markdown text-sm leading-6"
      // Jira rendered HTML is sanitized before rendering.
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
