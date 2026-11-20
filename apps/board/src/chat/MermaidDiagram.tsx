import DOMPurify from "dompurify";
import type { DiagramType } from "pele/lazy";
import { use, useState } from "react";

type Pele = typeof import("pele/lazy");
type PeleLoad = { readonly status: "loaded"; readonly pele: Pele } | { readonly status: "failed" };

let coreLoad: Promise<PeleLoad> | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only its parser and layout.
const diagramLoads = new Map<DiagramType, Promise<PeleLoad>>();

function loadCore(): Promise<PeleLoad> {
  coreLoad ??= import("pele/lazy").then(
    (pele): PeleLoad => ({ status: "loaded", pele }),
    (): PeleLoad => ({ status: "failed" }),
  );
  return coreLoad;
}

function loadDiagramType(pele: Pele, type: DiagramType): Promise<PeleLoad> {
  let load = diagramLoads.get(type);
  if (!load) {
    load = pele.load(type).then(
      (): PeleLoad => ({ status: "loaded", pele }),
      (): PeleLoad => ({ status: "failed" }),
    );
    diagramLoads.set(type, load);
  }
  return load;
}

function detectDiagramType(pele: Pele, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

// A reply can quote untrusted text. Pele escapes labels and turns links and images off, so this is
// defense in depth against anything that could navigate, run script, or fetch remote content.
function sanitizeDiagramSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

export function MermaidDiagram({ source }: { source: string }) {
  const [renderError, setRenderError] = useState<string | null>(null);
  const trimmed = source.trim();
  const core = use(loadCore());
  const type = core.status === "loaded" ? detectDiagramType(core.pele, trimmed) : null;
  const load = core.status === "loaded" && type ? use(loadDiagramType(core.pele, type)) : core;

  const mount = (container: HTMLSpanElement) => {
    if (load.status !== "loaded") return;
    const mounted = load.pele.mount(container, trimmed, {
      links: false,
      images: false,
      zoom: false,
      // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
      sanitize: sanitizeDiagramSvg,
      onRender: () => setRenderError(null),
      onError: (error) =>
        setRenderError(
          error instanceof Error ? error.message : "The diagram could not be rendered.",
        ),
    });
    return () => mounted.destroy();
  };

  if (load.status === "failed") throw new Error("The diagram renderer failed to load.");
  return (
    <div className="overflow-x-auto px-2 pb-2" data-testid="mermaid-diagram">
      {renderError !== null && (
        <p role="alert" className="m-0 text-xs text-red-400">
          Unable to render diagram: {renderError}
        </p>
      )}
      <span ref={mount} hidden={renderError !== null} className="flex w-full justify-center" />
    </div>
  );
}
