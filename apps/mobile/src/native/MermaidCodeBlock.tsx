import type { DiagramType } from "pele/lazy";
import { Suspense, use, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { mermaidSvgForNative } from "../lib/mermaidSvg";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

type Pele = typeof import("pele/lazy");
type Diagram =
  | {
      readonly status: "ready";
      readonly svg: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly status: "error"; readonly message: string };

let peleLoad: Promise<Pele | null> | null = null;
// Each diagram type is its own chunk, so a thread with one flowchart only
// evaluates the flowchart parser and layout.
const typeLoads = new Map<DiagramType, Promise<boolean>>();
// A message scrolled back into view reuses its settled promise, which `use`
// reads without suspending, instead of flashing the source.
const diagramLoads = new Map<string, Promise<Diagram>>();
const DIAGRAM_CACHE_LIMIT = 64;

function loadDiagram(source: string): Promise<Diagram> {
  let load = diagramLoads.get(source);
  if (!load) {
    if (diagramLoads.size >= DIAGRAM_CACHE_LIMIT) {
      diagramLoads.delete(diagramLoads.keys().next().value!);
    }
    load = renderDiagram(source);
    diagramLoads.set(source, load);
  }
  return load;
}

const MONOSPACE = Platform.OS === "ios" ? "Menlo" : "monospace";
// Pele measures labels with metrics close to Helvetica when no canvas is available.
const DIAGRAM_FONT = Platform.OS === "ios" ? "Helvetica" : "sans-serif";

async function renderDiagram(source: string): Promise<Diagram> {
  peleLoad ??= import("pele/lazy").catch(() => null);
  const pele = await peleLoad;
  if (!pele) {
    // Not cached, so the next mount tries again.
    peleLoad = null;
    diagramLoads.delete(source);
    return { status: "error", message: "The diagram renderer failed to load." };
  }
  let type: DiagramType | null = null;
  try {
    type = pele.detectType(source);
  } catch {
    // An unknown type falls through to render, which reports why.
  }
  if (type) {
    let load = typeLoads.get(type);
    if (!load) {
      load = pele.load(type).then(
        () => true,
        () => false,
      );
      typeLoads.set(type, load);
    }
    if (!(await load)) {
      typeLoads.delete(type);
      diagramLoads.delete(source);
      return { status: "error", message: "The diagram renderer failed to load." };
    }
  }
  try {
    const { svg, width, height } = pele.render(source, {
      links: false,
      images: false,
      // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
    });
    return { status: "ready", svg, width, height };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The diagram could not be rendered.",
    };
  }
}

type MermaidCodeBlockProps = {
  readonly code: string;
  readonly textStyle: NativeMarkdownTextStyle;
};

/** A complete ```mermaid fence, drawn as its diagram with a toggle back to the source. */
export function MermaidCodeBlock(props: MermaidCodeBlockProps) {
  return (
    <Suspense fallback={<MermaidBlock {...props} diagram={null} />}>
      <RenderedMermaidBlock {...props} />
    </Suspense>
  );
}

function RenderedMermaidBlock(props: MermaidCodeBlockProps) {
  return <MermaidBlock {...props} diagram={use(loadDiagram(props.code.trim()))} />;
}

function MermaidBlock(props: MermaidCodeBlockProps & { readonly diagram: Diagram | null }) {
  const { code, textStyle, diagram } = props;
  const [showCode, setShowCode] = useState(false);
  const secondaryColor = themeColorWithAlpha(textStyle.codeColor, 0.6);
  const codeFontSize = textStyle.fontSize * 0.9;
  const svg =
    diagram?.status === "ready"
      ? mermaidSvgForNative(diagram.svg, {
          "--pele-bg": textStyle.codeBlockBackgroundColor,
          "--pele-fg": textStyle.color,
          "--pele-muted": themeColorWithAlpha(textStyle.color, 0.65),
          "--pele-line": themeColorWithAlpha(textStyle.color, 0.55),
          "--pele-surface": themeColorWithAlpha(textStyle.color, 0.06),
          "--pele-surface-alt": themeColorWithAlpha(textStyle.color, 0.12),
          "--pele-border": themeColorWithAlpha(textStyle.color, 0.28),
          "--pele-accent": textStyle.linkColor,
          "--pele-font": DIAGRAM_FONT,
          "--pele-font-mono": MONOSPACE,
        })
      : null;

  // The header copies the native code block's, which this block replaces once the fence closes.
  return (
    <View
      style={[
        styles.block,
        {
          backgroundColor: textStyle.codeBlockBackgroundColor,
          borderColor: textStyle.dividerColor,
        },
      ]}
    >
      <View
        style={[
          styles.header,
          { borderBottomColor: themeColorWithAlpha(textStyle.codeColor, 0.2) },
        ]}
      >
        <Text style={[styles.language, { color: secondaryColor, fontSize: codeFontSize * 0.85 }]}>
          Mermaid
        </Text>
        <View style={styles.actions}>
          {svg ? (
            <HeaderButton
              icon={showCode ? "flowchart" : "chevron.left.forwardslash.chevron.right"}
              label={showCode ? "Show diagram" : "Show code"}
              color={secondaryColor}
              onPress={() => setShowCode((value) => !value)}
            />
          ) : null}
          <HeaderButton
            icon="doc.on.doc"
            label="Copy code"
            color={secondaryColor}
            onPress={() => copyTextWithHaptic(code)}
          />
        </View>
      </View>
      <View style={styles.content}>
        {diagram?.status === "error" ? (
          <Text style={[styles.error, { color: secondaryColor, fontSize: codeFontSize * 0.85 }]}>
            Unable to render diagram: {diagram.message}
          </Text>
        ) : null}
        {svg && diagram?.status === "ready" && !showCode ? (
          // In a row the width resolves first, so the height follows the shrunk width;
          // a column with maxWidth would size the height from the full width.
          <View style={styles.diagramRow}>
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel="Mermaid diagram"
              style={{
                flexBasis: diagram.width,
                flexShrink: 1,
                aspectRatio: diagram.width / diagram.height,
              }}
            >
              <SvgXml xml={svg} width="100%" height="100%" />
            </View>
          </View>
        ) : (
          <Text
            selectable
            style={{
              color: textStyle.codeColor,
              fontFamily: MONOSPACE,
              fontSize: codeFontSize,
              lineHeight: codeFontSize * 1.45,
            }}
          >
            {code}
          </Text>
        )}
      </View>
    </View>
  );
}

function HeaderButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly color: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={14} tintColor={props.color} type="monochrome" />
    </Pressable>
  );
}

// The block slot already applies the code block's outer margins.
const styles = StyleSheet.create({
  block: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  header: {
    height: 32,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  language: { fontWeight: "500" },
  actions: { flexDirection: "row", alignItems: "center", gap: 14 },
  content: { padding: 12 },
  diagramRow: { flexDirection: "row", justifyContent: "center" },
  error: { marginBottom: 8 },
});
