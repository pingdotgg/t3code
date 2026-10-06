import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  type ClaudePluginUiChild,
  type ClaudePluginUiElement,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Draws what Claude Code plugins put on screen for this thread: the band a
 * plugin's `ui.render` hook draws above the prompt, its `$.ui.status` lines
 * and its `$.ui.toast` notices. Plugins lay out in terminal cells, so the
 * band is monospace and sizes in `ch`.
 */
export function ClaudePluginUiBand(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const snapshot = useEnvironmentQuery(
    serverEnvironment.claudePluginUi({ environmentId, input: { threadId } }),
  ).data;
  const pressCommand = useAtomCommand(serverEnvironment.pressClaudePluginUi, {
    reportFailure: false,
    reportDefect: false,
  });
  // `undefined` until the first snapshot lands; a toast already in it is stale.
  const shownToastId = useRef<string | null | undefined>(undefined);
  const hasSnapshot = snapshot !== null;
  const toast = snapshot?.toast ?? null;

  useEffect(() => {
    if (!hasSnapshot) return;
    if (shownToastId.current === undefined) {
      shownToastId.current = toast?.id ?? null;
      return;
    }
    if (toast === null || shownToastId.current === toast.id) return;
    shownToastId.current = toast.id;
    toastManager.add({
      type: "info",
      title: toast.plugin,
      description: toast.text,
      timeout: toast.timeoutMs,
    });
  }, [hasSnapshot, toast]);

  if (snapshot === null || (snapshot.band === null && snapshot.statuses.length === 0)) {
    return null;
  }

  const press = (target: { plugin: string; handle: number }, key: string | undefined) => {
    void pressCommand({
      environmentId,
      input: { threadId, ...target, ...(key === undefined ? {} : { key }) },
    });
  };

  return (
    <div className="mx-auto mb-1.5 flex w-full max-w-208 flex-col gap-1 px-1 font-mono text-xs leading-tight">
      {snapshot.band === null ? null : (
        <div className="overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 leading-none [container-type:inline-size]">
          {/* Shrink below text-xs when the composer is narrower than the plugin's columns. */}
          <div
            style={{
              fontSize: `min(0.75rem, calc(100cqi / ${CLAUDE_PLUGIN_UI_BAND_COLUMNS * MONO_CH_EM}))`,
            }}
          >
            {renderNode(snapshot.band, "band", press)}
          </div>
        </div>
      )}
      {snapshot.statuses.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 text-muted-foreground">
          {snapshot.statuses.map((status) => (
            <span key={status.plugin} className="whitespace-pre">
              {status.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type Press = (target: { plugin: string; handle: number }, key: string | undefined) => void;

/** A horizontal size in terminal cells (`ch`); strings pass through as CSS. */
const cells = (value: unknown): string | undefined =>
  typeof value === "number" ? `${value}ch` : typeof value === "string" ? value : undefined;

/** A vertical size in terminal rows; strings pass through as CSS. */
const lines = (value: unknown): string | undefined =>
  typeof value === "number" ? `${value * 1.25}em` : typeof value === "string" ? value : undefined;

/** Ink-style color names and hex pass through; `ansi256(n)` has no CSS twin and is dropped. */
const color = (value: unknown): string | undefined =>
  typeof value === "string" && !value.startsWith("ansi") ? value : undefined;

/** Maps an Ink-style Box's layout props to flexbox CSS. */
function boxStyle(props: Readonly<Record<string, unknown>>): CSSProperties {
  const style: CSSProperties = {
    display: props.display === "none" ? "none" : "flex",
    flexDirection: (props.flexDirection as CSSProperties["flexDirection"]) ?? "row",
  };
  const set = <K extends keyof CSSProperties>(key: K, value: CSSProperties[K] | undefined) => {
    if (value !== undefined) style[key] = value;
  };
  set("gap", cells(props.gap));
  set("columnGap", cells(props.columnGap));
  set("rowGap", lines(props.rowGap));
  set(
    "padding",
    props.padding === undefined ? undefined : `${lines(props.padding)} ${cells(props.padding)}`,
  );
  set("paddingLeft", cells(props.paddingLeft ?? props.paddingX));
  set("paddingRight", cells(props.paddingRight ?? props.paddingX));
  set("paddingTop", lines(props.paddingTop ?? props.paddingY));
  set("paddingBottom", lines(props.paddingBottom ?? props.paddingY));
  set("marginLeft", cells(props.marginLeft ?? props.marginX));
  set("marginRight", cells(props.marginRight ?? props.marginX));
  set("marginTop", lines(props.marginTop ?? props.marginY));
  set("marginBottom", lines(props.marginBottom ?? props.marginY));
  set("width", cells(props.width));
  set("minWidth", cells(props.minWidth));
  set("height", lines(props.height));
  set("flexGrow", typeof props.flexGrow === "number" ? props.flexGrow : undefined);
  set("flexShrink", typeof props.flexShrink === "number" ? props.flexShrink : undefined);
  set("flexWrap", props.flexWrap as CSSProperties["flexWrap"]);
  set("alignItems", props.alignItems as CSSProperties["alignItems"]);
  set("justifyContent", props.justifyContent as CSSProperties["justifyContent"]);
  set("backgroundColor", color(props.backgroundColor));
  if (typeof props.borderStyle === "string") {
    style.border = `1px ${props.borderStyle === "double" ? "double" : "solid"} ${
      color(props.borderColor) ?? "var(--border)"
    }`;
    style.borderRadius = props.borderStyle === "round" ? "0.375rem" : undefined;
    style.padding ??= "0 1ch";
  }
  return style;
}

/** Maps an Ink-style Text's color and style props to CSS. */
function textStyle(props: Readonly<Record<string, unknown>>): CSSProperties {
  const inverse = props.inverse === true;
  const fg = color(props.color);
  const bg = color(props.backgroundColor);
  const decorations = [
    props.underline === true ? "underline" : null,
    props.strikethrough === true ? "line-through" : null,
  ].filter((decoration) => decoration !== null);
  return {
    // Ink wraps Text by default; the `truncate*` modes cut it to one line.
    ...(typeof props.wrap === "string" && props.wrap.startsWith("truncate")
      ? { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }
      : { whiteSpace: "pre-wrap" }),
    ...(fg === undefined && !inverse ? {} : { color: inverse ? (bg ?? "var(--background)") : fg }),
    ...(bg === undefined && !inverse
      ? {}
      : { backgroundColor: inverse ? (fg ?? "var(--foreground)") : bg }),
    ...(props.bold === true ? { fontWeight: 600 } : {}),
    ...(props.italic === true ? { fontStyle: "italic" } : {}),
    ...(props.dimColor === true ? { opacity: 0.6 } : {}),
    ...(decorations.length === 0 ? {} : { textDecoration: decorations.join(" ") }),
  };
}

/** Text styling a plugin may set on a div/span/b; layout and positioning stay ours. */
const ALLOWED_DECLARATIONS = new Set([
  "color",
  "backgroundColor",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "opacity",
  "whiteSpace",
]);

/** Parses the `style` declaration string a plugin put on a div/span/b. */
function declarations(value: unknown): CSSProperties {
  if (typeof value !== "string") return {};
  const style: Record<string, string> = {};
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const property = declaration
      .slice(0, separator)
      .trim()
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!ALLOWED_DECLARATIONS.has(property) || /url\(/i.test(propertyValue)) continue;
    style[property] = propertyValue;
  }
  return style as CSSProperties;
}

/** Only web links open from a plugin's tree. */
function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Width of one monospace cell in em (SF Mono and Menlo are 0.6). */
const MONO_CH_EM = 0.6;

// Block elements drawn as shapes, not glyphs: a font's block glyphs leave
// anti-aliased seams between cells, which stripes plugin pixel art.
// Quadrant bits: 8 top-left, 4 top-right, 2 bottom-left, 1 bottom-right.
const BLOCK_QUADRANTS: Readonly<Record<string, number>> = {
  "█": 15,
  "▀": 12,
  "▄": 3,
  "▌": 10,
  "▐": 5,
  "▘": 8,
  "▝": 4,
  "▖": 2,
  "▗": 1,
  "▙": 11,
  "▛": 14,
  "▜": 13,
  "▟": 7,
  "▚": 9,
  "▞": 6,
};
const QUADRANT_POSITIONS: ReadonlyArray<readonly [number, string]> = [
  [8, "0 0"],
  [4, "100% 0"],
  [2, "0 100%"],
  [1, "100% 100%"],
];
const SOLID = "linear-gradient(currentColor, currentColor)";

/**
 * One block element, or a run of `count` identical full or half blocks, as a
 * painted box. Boxes overlap their right and bottom neighbours by half a pixel
 * so fractional cell edges never leave a seam.
 */
function blockStyle(mask: number, count: number): CSSProperties {
  const layers = QUADRANT_POSITIONS.filter(([bit]) => (mask & bit) !== 0);
  const half = "calc(50% + 0.5px)";
  return {
    display: "inline-block",
    width: `calc(${count}ch + 0.5px)`,
    marginRight: "-0.5px",
    height: "calc(1lh + 0.5px)",
    marginBottom: "-0.5px",
    verticalAlign: "top",
    backgroundImage: layers.map(() => SOLID).join(", "),
    backgroundPosition: layers.map(([, position]) => position).join(", "),
    backgroundSize: count === 1 ? `${half} ${half}` : mask === 15 ? "100% 100%" : `100% ${half}`,
    backgroundRepeat: "no-repeat",
  };
}

/** Full and half blocks look the same at any width, so their runs draw as one box. */
const MERGEABLE_MASKS = new Set([15, 12, 3]);

/** Draws a string, painting block elements as boxes and everything else as text. */
function renderText(text: string, key: string): ReactNode {
  const chars = [...text];
  if (!chars.some((char) => char in BLOCK_QUADRANTS)) {
    return (
      <span key={key} className="whitespace-pre-wrap">
        {text}
      </span>
    );
  }
  const parts: ReactNode[] = [];
  let plain = "";
  for (let index = 0; index < chars.length;) {
    const char = chars[index] as string;
    const mask = BLOCK_QUADRANTS[char];
    if (mask === undefined) {
      plain += char;
      index += 1;
      continue;
    }
    if (plain !== "") {
      parts.push(plain);
      plain = "";
    }
    let count = 1;
    if (MERGEABLE_MASKS.has(mask)) while (chars[index + count] === char) count += 1;
    parts.push(<span key={index} aria-hidden style={blockStyle(mask, count)} />);
    index += count;
  }
  if (plain !== "") parts.push(plain);
  return (
    <span key={key} className="whitespace-pre">
      {parts}
    </span>
  );
}

/** Draws a node's children in order. */
function renderChildren(
  children: ReadonlyArray<ClaudePluginUiChild> | undefined,
  path: string,
  press: Press,
): ReactNode {
  // A plugin's tree is positional: its children carry no ids of their own.
  return children?.map((child, index) =>
    typeof child === "string"
      ? renderText(child, `${path}.${index}`)
      : renderNode(child, `${path}.${index}`, press),
  );
}

/** Draws one plugin tree node from the desktop element table; unknown types draw nothing. */
function renderNode(node: ClaudePluginUiElement, path: string, press: Press): ReactNode {
  const props = node.props ?? {};
  const key = typeof props.key === "string" ? props.key : path;
  switch (node.type) {
    case "Box":
      return (
        <div key={key} style={boxStyle(props)}>
          {renderChildren(node.children, path, press)}
        </div>
      );
    case "Text":
      return (
        <span key={key} style={textStyle(props)}>
          {renderChildren(node.children, path, press)}
        </span>
      );
    case "div":
    case "span":
    case "b": {
      const Tag = node.type;
      return (
        <Tag key={key} style={declarations(props.style)}>
          {renderChildren(node.children, path, press)}
        </Tag>
      );
    }
    case "Button": {
      const label = typeof props.label === "string" ? props.label : "";
      const target = node.press;
      return (
        <button
          key={key}
          type="button"
          disabled={target === undefined}
          onClick={() =>
            target && press(target, typeof props.key === "string" ? props.key : undefined)
          }
          className={
            props.plain === true
              ? "whitespace-pre hover:underline"
              : props.variant === "primary"
                ? "whitespace-pre rounded bg-primary px-1.5 text-primary-foreground hover:bg-primary/90"
                : "whitespace-pre rounded border border-border px-1.5 hover:bg-accent"
          }
          style={props.dimColor === true ? { opacity: 0.6 } : undefined}
        >
          {label}
        </button>
      );
    }
    case "Link": {
      const href = safeHref(props.href);
      return (
        <a key={key} href={href} target="_blank" rel="noreferrer" className="underline">
          {typeof props.label === "string" ? props.label : href}
          {renderChildren(node.children, path, press)}
        </a>
      );
    }
    case "Code":
    case "Markdown": {
      const source = typeof props.source === "string" ? props.source : null;
      return (
        <span key={key} className="whitespace-pre-wrap">
          {source ?? renderChildren(node.children, path, press)}
        </span>
      );
    }
    default:
      // Input, Select, Svg, Client: not drawn on this surface yet.
      return null;
  }
}
