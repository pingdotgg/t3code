type MermaidTheme = "light" | "dark";

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let initializedTheme: MermaidTheme | null = null;
let renderCount = 0;

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidModulePromise ??= import("mermaid");
  return mermaidModulePromise;
}

function mermaidApi(mod: typeof import("mermaid")) {
  return mod.default;
}

export async function renderMermaidSvg(source: string, theme: MermaidTheme): Promise<string> {
  const mermaid = mermaidApi(await loadMermaid());
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Failed mermaid.render() otherwise leaves a temp error diagram on
      // document.body (unique id per call, so later renders never reclaim it).
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: theme === "dark" ? "dark" : "neutral",
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
    });
    initializedTheme = theme;
  }

  renderCount += 1;
  const { svg } = await mermaid.render(`t3mermaid${renderCount}`, source);
  return svg;
}

export function resetMermaidRendererForTests(): void {
  mermaidModulePromise = null;
  initializedTheme = null;
  renderCount = 0;
}
