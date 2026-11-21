import { T } from "gt-react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { MermaidDiagram } from "../chat/MermaidDiagram";

export default function MermaidViewer(props: { readonly text: string }) {
  const theme = useRenderedAppearance();
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
        <T>
          This diagram contains resource URLs, markup, node metadata, or custom configuration. Show
          Mermaid source to inspect it safely.
        </T>
      </div>
    );
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto p-6 [&_*]:animate-none!">
      {/* Fork: Lathe keeps its own Mermaid renderer, which brings its own expanded viewer. */}
      <MermaidDiagram source={props.text} theme={theme} pending={false} />
    </div>
  );
}
