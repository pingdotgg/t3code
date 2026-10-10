import { useEffect, useMemo, useRef, useState } from "react";
import type { LatexRenderingMode } from "@t3tools/contracts/settings";
import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";

type MathPlugins = typeof import("./markdownMath").CHAT_MATH_PLUGINS;
type ActiveMathMode = Exclude<LatexRenderingMode, "off">;

const loadedPlugins: Partial<Record<ActiveMathMode, MathPlugins>> = {};
const loadingPlugins: Partial<Record<ActiveMathMode, Promise<MathPlugins>>> = {};

function hasMathOpening(text: string): boolean {
  if (!text.includes("\\(") && !text.includes("\\[") && !text.includes("$$")) return false;
  for (const match of text.matchAll(/\\[([]|\$\$/g)) {
    let preceding = match.index - 1;
    while (text[preceding] === "\\") preceding--;
    if ((match.index - preceding - 1) % 2 === 0) return true;
  }
  return false;
}

function hasMathOutsideCode(node: Root | RootContent, source: string): boolean {
  if (node.type === "text") {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start !== undefined && end !== undefined && hasMathOpening(source.slice(start, end));
  }
  return "children" in node && node.children.some((child) => hasMathOutsideCode(child, source));
}

export function loadChatMathPlugins(mode: ActiveMathMode = "on"): Promise<MathPlugins> {
  loadingPlugins[mode] ??= (
    mode === "on" ? import("./markdownMathRendered") : import("./markdownMathReadable")
  )
    .then(({ CHAT_MATH_PLUGINS }) => {
      loadedPlugins[mode] = CHAT_MATH_PLUGINS;
      return CHAT_MATH_PLUGINS;
    })
    .catch((error: unknown) => {
      delete loadingPlugins[mode];
      throw error;
    });
  return loadingPlugins[mode];
}

/** Ordinary messages keep their pipeline. Readable mode does not load typesetting styles or fonts. */
export function useChatMathPlugins(mode: LatexRenderingMode, text: string) {
  const needed = mode !== "off" && hasMathOpening(text);
  const parsedMath = useRef({ source: "", needed: false });
  const probePlugins = useMemo(() => {
    // Reuse ReactMarkdown's parse to exclude code without parsing the message a second time.
    const probe: Plugin<[], Root> = () => (tree, file) => {
      const source = String(file.value);
      parsedMath.current = { source, needed: hasMathOutsideCode(tree, source) };
    };
    return { remark: [probe], rehype: CHAT_MARKDOWN_REHYPE_PLUGINS, literalRehype: [] };
  }, []);
  const [loaded, setLoaded] = useState<{ mode: ActiveMathMode; plugins: MathPlugins }>();
  const plugins =
    mode !== "off"
      ? (loadedPlugins[mode] ?? (loaded?.mode === mode ? loaded.plugins : undefined))
      : undefined;
  useEffect(() => {
    if (!needed || plugins || parsedMath.current.source !== text || !parsedMath.current.needed) {
      return;
    }
    let cancelled = false;
    void loadChatMathPlugins(mode).then(
      (result) => {
        if (!cancelled) setLoaded({ mode, plugins: result });
      },
      () => {
        // A failed chunk download leaves the original Markdown readable.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mode, needed, plugins, text]);
  return needed ? (plugins ?? probePlugins) : undefined;
}
