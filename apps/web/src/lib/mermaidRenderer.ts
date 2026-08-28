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
      htmlLabels: false,
      theme: theme === "dark" ? "dark" : "neutral",
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
