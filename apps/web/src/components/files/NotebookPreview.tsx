/* oxlint-disable react/no-array-index-key -- Notebook cells and outputs retain their saved source order. */
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useEffect, useRef, useState } from "react";
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
  readonly sizeBytes?: number | undefined;
}) {
  const [visible, setVisible] = useState(20);
  const scroll = useRef<HTMLDivElement>(null);
  const [outputView, setOutputView] = useState(() => ({
    mounted: new Set<string>(),
    heights: new Map<string, number>(),
  }));
  const outputCount = props.notebook.cells
    .slice(0, visible)
    .reduce(
      (count, cell) => count + cell.outputs.filter((output) => output.kind === "html").length,
      0,
    );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe output visibility and measure departing outputs to bound iframe lifetimes while preserving scroll height.
  useEffect(() => {
    const root = scroll.current;
    if (!root || !outputCount) return;
    const candidates = new Map<Element, string>();
    let active: Element[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            candidates.set(entry.target, (entry.target as HTMLElement).dataset.notebookOutput!);
          else candidates.delete(entry.target);
        }
        // Bound browsing contexts even when a cell contains hundreds of tiny HTML outputs.
        const next = [...candidates.keys()].slice(0, 16);
        const measured = active
          .filter((node) => !next.includes(node))
          .map(
            (node) =>
              [
                (node as HTMLElement).dataset.notebookOutput!,
                node.getBoundingClientRect().height,
              ] as const,
          );
        active = next;
        setOutputView((old) => ({
          mounted: new Set(next.map((node) => candidates.get(node)!)),
          heights: new Map([...old.heights, ...measured]),
        }));
      },
      { root, rootMargin: "160px" },
    );
    for (const node of root.querySelectorAll("[data-notebook-output]")) observer.observe(node);
    return () => observer.disconnect();
  }, [outputCount]);
  return (
    <>
      <div
        className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground tabular-nums"
        role="status"
      >
        {props.notebook.cells.length.toLocaleString()} cells · {props.notebook.language}
        {props.sizeBytes !== undefined
          ? ` · ${props.sizeBytes === 0 ? "0 bytes" : formatAttachmentSize(props.sizeBytes)}`
          : ""}
      </div>
      <FileSurfaceNotice>Saved outputs only. Code is never executed.</FileSurfaceNotice>
      <div ref={scroll} className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
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
                <div
                  key={outputIndex}
                  data-notebook-output={
                    output.kind === "html" ? `${index}-${outputIndex}` : undefined
                  }
                  className="border-t border-border/60"
                  style={{
                    minHeight:
                      output.kind !== "html" || outputView.mounted.has(`${index}-${outputIndex}`)
                        ? undefined
                        : (outputView.heights.get(`${index}-${outputIndex}`) ?? 80),
                  }}
                >
                  {output.kind === "html" ? (
                    !outputView.mounted.has(`${index}-${outputIndex}`) ? null : (
                      <DocumentPages
                        html={output.text}
                        name={`Cell ${index + 1} HTML output`}
                        output
                      />
                    )
                  ) : output.kind === "image" ? (
                    <img
                      src={output.text}
                      alt={`Cell ${index + 1} output`}
                      loading="lazy"
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
