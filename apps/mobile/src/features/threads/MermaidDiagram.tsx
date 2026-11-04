import { Suspense, use, useMemo, useState, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";

import type { MobileThemeVariables } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

type Pele = typeof import("pele");

let peleLoad: Promise<Pele | null> | null = null;

// Pele is large; load it only once a thread contains a diagram.
function loadPele(): Promise<Pele | null> {
  peleLoad ??= import("pele").then(
    (pele) => pele,
    () => null,
  );
  return peleLoad;
}

function diagramHtml(svg: string, theme: MobileThemeVariables): string {
  const variables = {
    "--pele-bg": theme["--color-thread-canvas"],
    "--pele-fg": theme["--color-foreground"],
    "--pele-muted": theme["--color-foreground-muted"],
    "--pele-line": theme["--color-foreground-muted"],
    "--pele-surface": theme["--color-secondary"],
    "--pele-surface-alt": theme["--color-subtle-strong"],
    "--pele-border": theme["--color-border"],
    "--pele-accent": theme["--color-primary"],
    "--pele-critical": theme["--color-danger"],
  };
  const css = Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>:root{${css}}html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`;
}

function RenderedMermaidDiagram(props: { readonly source: string; readonly fallback: ReactNode }) {
  const pele = use(loadPele());
  const theme = useUniwindTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [crashed, setCrashed] = useState(false);
  const restart = () => {
    if (generation > 0) {
      setCrashed(true);
      return;
    }
    setGeneration(1);
  };
  const rendered = useMemo(() => {
    if (!pele) return null;
    try {
      // Pele escapes labels; links and images are off so the SVG cannot navigate or fetch.
      // maxWidth lets Pele turn a wide flowchart vertical, because fitting it to a phone makes
      // labels too small to read and this view cannot zoom.
      return pele.render(props.source, { links: false, images: false, maxWidth: windowWidth });
    } catch {
      return null;
    }
  }, [pele, props.source, windowWidth]);
  const html = useMemo(
    () => (rendered ? { html: diagramHtml(rendered.svg, theme) } : null),
    [rendered, theme],
  );
  if (crashed || !rendered || !html || rendered.width <= 0 || rendered.height <= 0) {
    return props.fallback;
  }

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Mermaid diagram: ${props.source}`}
      // The feed scrolls through the diagram; it has nothing to interact with.
      pointerEvents="none"
      style={{
        width: "100%",
        maxWidth: rendered.width,
        alignSelf: "center",
        marginVertical: 8,
      }}
    >
      <View style={{ width: "100%", height: (width * rendered.height) / rendered.width }}>
        <WebView
          key={generation}
          source={html}
          javaScriptEnabled={false}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          onContentProcessDidTerminate={restart}
          onRenderProcessGone={restart}
          onError={() => setCrashed(true)}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </View>
    </View>
  );
}

/** Renders a mermaid fence, or `fallback` (the raw code block) when it cannot be drawn. */
export function MermaidDiagram(props: { readonly source: string; readonly fallback: ReactNode }) {
  return (
    <Suspense fallback={props.fallback}>
      <RenderedMermaidDiagram source={props.source} fallback={props.fallback} />
    </Suspense>
  );
}
