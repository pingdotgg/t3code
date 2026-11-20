import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import "./Markdown.css";

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    // react-markdown gives fences a trailing newline; inline code has none and no language.
    if (language !== undefined || text.endsWith("\n")) {
      return <CodeBlock code={text.replace(/\n$/, "")} language={language} />;
    }
    return <code className="m-md-code">{children}</code>;
  },
  img: ({ src, alt }) => (
    <img className="m-md-img" src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />
  ),
};

/**
 * The agent's markdown as the app's native renderer shows it (16/23 body). `muted` is the question
 * panel's context: one size smaller and every colour, bold, code and bullets included, muted.
 */
export function MarkdownText(props: { readonly markdown: string; readonly muted?: boolean }) {
  return (
    <div className="m-md" data-muted={props.muted ? "true" : undefined}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {props.markdown}
      </Markdown>
    </div>
  );
}
