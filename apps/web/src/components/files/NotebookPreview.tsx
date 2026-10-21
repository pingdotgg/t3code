/* oxlint-disable react/no-array-index-key -- Notebook cells and outputs retain their saved source order. */
import { useState } from "react";
import type { Root, RootContent } from "mdast";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import ReadOnlySourcePreview from "./ReadOnlySourcePreview";
import DocumentPages from "./DocumentPages";
import { FileSurfaceNotice } from "./fileSurfaceChrome";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

// Saved notebooks must not load URLs or turn authored links into app actions.
function inertNotebookMarkdown() {
  function clean(nodes: RootContent[]): RootContent[] {
    return nodes.flatMap((node): RootContent[] => {
      if (node.type === "html" || node.type === "definition") return [];
      if (node.type === "image" || node.type === "imageReference")
        return [{ type: "text", value: node.alt ?? "" }];
      if (node.type === "link" || node.type === "linkReference") return clean(node.children);
      if (node.type === "inlineCode") return [{ type: "text", value: node.value }];
      if (node.type === "code" && node.lang === "mermaid") return [{ ...node, lang: "text" }];
      if ("children" in node) node.children = clean(node.children) as typeof node.children;
      return [node];
    });
  }
  return (tree: Root) => {
    tree.children = clean(tree.children) as Root["children"];
  };
}
const NOTEBOOK_PLUGINS = [inertNotebookMarkdown];

function NotebookSource(props: { readonly name: string; readonly text: string }) {
  const [height, setHeight] = useState(Math.min(360, props.text.split("\n").length * 20 + 16));
  const measure = (node: HTMLElement) => {
    setHeight(Math.min(360, Math.ceil(node.getBoundingClientRect().height)));
  };
  return (
    <div className="flex min-h-0 flex-col" style={{ height }}>
      <ReadOnlySourcePreview {...props} onPostRender={measure} />
    </div>
  );
}

export default function NotebookPreview(props: {
  readonly notebook: Extract<OfficeWorkerResult, { type: "notebook" }>;
}) {
  const [visible, setVisible] = useState(20);
  return (
    <>
      <FileSurfaceNotice>Saved outputs only. Code is never executed.</FileSurfaceNotice>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-5 py-6">
          {props.notebook.cells.slice(0, visible).map((cell, index) => (
            <section
              key={index}
              aria-label={`Cell ${index + 1}`}
              className="min-w-0 overflow-hidden rounded-md border border-border/60"
            >
              <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                {cell.kind === "code" ? props.notebook.language : cell.kind} · {index + 1}
              </div>
              {cell.kind === "markdown" ? (
                <ChatMarkdown
                  text={cell.source}
                  cwd={undefined}
                  parseRawHtml={false}
                  extraRemarkPlugins={NOTEBOOK_PLUGINS}
                  className="px-4 py-3"
                />
              ) : cell.source.trim() ? (
                <NotebookSource
                  name={`cell.${cell.kind === "code" ? (({ python: "py", javascript: "js", typescript: "ts", julia: "jl" } as Record<string, string>)[props.notebook.language] ?? props.notebook.language) : "txt"}`}
                  text={cell.source}
                />
              ) : null}
              {cell.outputs.map((output, outputIndex) => (
                <div key={outputIndex} className="border-t border-border/60">
                  {output.kind === "html" ? (
                    <DocumentPages
                      html={output.text}
                      name={`Cell ${index + 1} HTML output`}
                      output
                    />
                  ) : output.kind === "image" ? (
                    <img
                      src={output.text}
                      alt={`Cell ${index + 1} output`}
                      className="max-h-96 max-w-full p-4 object-contain"
                    />
                  ) : (
                    <pre className="overflow-x-auto p-4 text-xs whitespace-pre-wrap break-words">
                      {output.text}
                    </pre>
                  )}
                </div>
              ))}
            </section>
          ))}
          {props.notebook.cells.length === 0 ? (
            <p className="text-sm text-muted-foreground">This notebook is empty.</p>
          ) : null}
          {visible < props.notebook.cells.length ? (
            <Button variant="outline" size="sm" onClick={() => setVisible((count) => count + 20)}>
              Show more cells ({props.notebook.cells.length - visible} remaining)
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}
