import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Markdown the way settings pages read it. Code wraps at phone width. Links and images stay plain
 * text, so reading a skill or an instruction file never opens a page or fetches anything.
 */
const SETTINGS_MARKDOWN_COMPONENTS = {
  pre: ({ children }) => (
    <pre className="my-2 whitespace-pre-wrap break-all rounded-md bg-muted/30 p-2">{children}</pre>
  ),
  code: ({ children }) => <code className="font-mono text-xs">{children}</code>,
  h1: ({ children }) => <h1 className="my-3 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-2 font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-2 font-medium">{children}</h3>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  a: ({ children }) => <span className="underline">{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
} satisfies Components;

export function SkillMarkdown({ text }: { text: string }) {
  return <ReactMarkdown components={SETTINGS_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>;
}
