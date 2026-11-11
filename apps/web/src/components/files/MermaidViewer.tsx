import { useState } from "react";

import { MermaidDiagram } from "../chat/MermaidDiagram";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";

export default function MermaidViewer(props: { readonly text: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Mermaid lays out DOM before sanitizing its SVG. Refuse resource and config
  // syntax before that pass so standalone files cannot initiate requests. Node
  // metadata is YAML, whose escaped/aliased image keys cannot be checked lexically.
  if (
    /%%\s*\{|^\s*---|<\/?[A-Za-z]|<[!?]|@\s*\{|\b(?:img|image)\s*:|url\s*\(|@import|(?:https?|data|blob|file):/im.test(
      props.text,
    )
  )
    return (
      <div role="alert" className="p-6 text-xs text-muted-foreground">
        This diagram contains resource URLs, markup, node metadata, or custom configuration. Show
        Mermaid source to inspect it safely.
      </div>
    );
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-6 [&_*]:animate-none!">
      <MermaidDiagram source={props.text} onExpand={setExpanded} />
      {expanded ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: expanded, name: "Mermaid diagram" }], index: 0 }}
          onClose={() => setExpanded(null)}
        />
      ) : null}
    </div>
  );
}
