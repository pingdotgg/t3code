/**
 * HTML export uses Tailwind v4, flex or absolute layout, and animation keyframes.
 * A node's imported or agent-set className wins over generated classes in its group.
 */
import type {
  CanvasAnimation,
  CanvasDocument,
  CanvasNode,
  CanvasPaint,
  CanvasShadow,
} from "@t3tools/contracts";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeHtml(value).replaceAll('"', "&quot;");

const num = (value: number) => String(Math.round(value * 100) / 100);
const px = (value: number) => `${num(value)}px`;

/** Tailwind v4 spacing scale is 4px steps in quarters; even pixel values read well as scale classes. */
function spacing(prefix: string, value: number): string {
  const abs = Math.abs(value);
  const token =
    abs === 1
      ? `${prefix}-px`
      : Number.isInteger(abs) && abs % 2 === 0
        ? `${prefix}-${num(abs / 4)}`
        : `${prefix}-[${px(abs)}]`;
  return value < 0 ? `-${token}` : token;
}

const RADIUS_SCALE: Record<number, string> = {
  2: "xs",
  4: "sm",
  6: "md",
  8: "lg",
  12: "xl",
  16: "2xl",
  24: "3xl",
  32: "4xl",
};

function radius(prefix: string, value: number, size: number): string {
  if (value >= size / 2 && size > 0) return `${prefix}-full`;
  const scale = RADIUS_SCALE[value];
  return scale ? `${prefix}-${scale}` : `${prefix}-[${px(value)}]`;
}

const FONT_SIZES: Record<number, string> = {
  12: "xs",
  14: "sm",
  16: "base",
  18: "lg",
  20: "xl",
  24: "2xl",
  30: "3xl",
  36: "4xl",
  48: "5xl",
  60: "6xl",
  72: "7xl",
  96: "8xl",
  128: "9xl",
};

const FONT_WEIGHTS: Record<number, string> = {
  100: "thin",
  200: "extralight",
  300: "light",
  400: "normal",
  500: "medium",
  600: "semibold",
  700: "bold",
  800: "extrabold",
  900: "black",
};

/** Arbitrary values cannot contain spaces; Tailwind reads `_` as a space. */
const arbitrary = (value: string) => value.replaceAll(" ", "_");

function colorClass(prefix: string, color: string): string {
  const lower = cssColor(color);
  if (lower === "#ffffff") return `${prefix}-white`;
  if (lower === "#000000") return `${prefix}-black`;
  if (lower.length === 9 && lower.endsWith("00")) return `${prefix}-transparent`;
  return `${prefix}-[${lower}]`;
}

function cssColor(color: string): string {
  return /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) ? color.toLowerCase() : "#000000";
}

function gradientCss(paint: CanvasPaint): string | null {
  if (paint.type === "linear-gradient") {
    const stops = paint.stops.map((stop) => `${cssColor(stop.color)} ${num(stop.offset * 100)}%`);
    return `linear-gradient(${num(paint.angle)}deg, ${stops.join(", ")})`;
  }
  if (paint.type === "radial-gradient") {
    const stops = paint.stops.map((stop) => `${cssColor(stop.color)} ${num(stop.offset * 100)}%`);
    const size = paint.size
      ? `ellipse ${num(paint.size.width * 50)}% ${num(paint.size.height * 50)}%`
      : "ellipse farthest-corner";
    const center = paint.center
      ? ` at ${num(paint.center.x * 100)}% ${num(paint.center.y * 100)}%`
      : "";
    const geometry = paint.size || paint.center ? `${size}${center}, ` : "";
    return `radial-gradient(${geometry}${stops.join(", ")})`;
  }
  return null;
}

function shadowCss(shadow: CanvasShadow): string {
  return `${shadow.inset ? "inset " : ""}${px(shadow.x)} ${px(shadow.y)} ${px(shadow.blur)} ${px(shadow.spread)} ${cssColor(shadow.color)}`;
}

/** Generated classes are grouped so a node's own className can replace a whole group. */
type ClassGroup =
  | "position"
  | "left"
  | "top"
  | "width"
  | "height"
  | "display"
  | "direction"
  | "gap"
  | "padding"
  | "align"
  | "justify"
  | "wrap"
  | "bg"
  | "border"
  | "outline"
  | "radius"
  | "shadow"
  | "opacity"
  | "rotate"
  | "blur"
  | "backdrop"
  | "blend"
  | "overflow"
  | "visibility"
  | "text"
  | "font"
  | "leading"
  | "tracking"
  | "textAlign"
  | "whitespace"
  | "italic"
  | "color";

const GROUP_PATTERNS: Array<[ClassGroup, RegExp]> = [
  ["position", /^(absolute|relative|fixed|sticky|static)$/],
  ["left", /^-?(left|inset-x|inset)-/],
  ["top", /^-?(top|inset-y|inset)-/],
  ["width", /^(w-|size-|min-w-|max-w-)/],
  ["height", /^(h-|size-|min-h-|max-h-)/],
  ["display", /^(flex|grid|block|inline|inline-block|inline-flex|hidden|contents)$/],
  ["direction", /^flex-(row|col)/],
  ["gap", /^gap-/],
  ["padding", /^p[xytrbl]?-/],
  ["align", /^items-/],
  ["justify", /^justify-/],
  ["wrap", /^flex-(wrap|nowrap)/],
  ["bg", /^bg-/],
  ["border", /^border/],
  ["outline", /^outline/],
  ["radius", /^rounded/],
  ["shadow", /^shadow/],
  ["opacity", /^opacity-/],
  ["rotate", /^-?rotate-/],
  ["blur", /^blur/],
  ["backdrop", /^backdrop-blur/],
  ["blend", /^mix-blend-/],
  ["overflow", /^overflow-/],
  ["visibility", /^(hidden|invisible|visible)$/],
  ["font", /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d)/],
  ["leading", /^leading-/],
  ["tracking", /^tracking-/],
  ["textAlign", /^text-(left|center|right|justify|start|end)$/],
  ["whitespace", /^whitespace-/],
  ["italic", /^(italic|not-italic)$/],
];

class Classes {
  private readonly entries: Array<[ClassGroup | null, string]> = [];
  add(group: ClassGroup | null, ...tokens: string[]): void {
    for (const token of tokens) if (token) this.entries.push([group, token]);
  }

  /** Merges with a node's own className: its tokens replace generated tokens of the same group. */
  render(own: string | undefined, parentDirection: "row" | "column" | null): string {
    const ownTokens = own?.split(/\s+/).filter(Boolean) ?? [];
    const overridden = new Set<ClassGroup>();
    for (const token of ownTokens) {
      for (const [group, pattern] of GROUP_PATTERNS) if (pattern.test(token)) overridden.add(group);
      // Flex sizing replaces the fixed size on the axis it controls.
      if (parentDirection && /^(flex-1|grow|flex-auto|basis-)/.test(token)) {
        overridden.add(parentDirection === "row" ? "width" : "height");
      }
      if (parentDirection && token === "self-stretch") {
        overridden.add(parentDirection === "row" ? "height" : "width");
      }
    }
    const generated = this.entries
      .filter(([group]) => group === null || !overridden.has(group))
      .map(([, token]) => token);
    return [...new Set([...generated, ...ownTokens])].join(" ");
  }
}

const EASINGS: Record<string, string> = {
  linear: "linear",
  ease: "ease",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};

interface ExportContext {
  readonly doc: CanvasDocument;
  readonly styles: string[];
  readonly shaders: { nodeId: string; fills: Extract<CanvasPaint, { type: "shader" }>[] }[];
}

const cssIdent = (value: string) => value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

/** One `@keyframes` per animation; the element's class plays them together. */
function animationCss(ctx: ExportContext, node: CanvasNode, inFlow: boolean): string | null {
  const animations = node.animations ?? [];
  if (animations.length === 0) return null;
  const className = `canvas-anim-${cssIdent(node.id)}`;
  const byTrigger = new Map<string, string[]>();
  for (const animation of animations) {
    const name = `canvas-${cssIdent(node.id)}-${cssIdent(animation.id)}`;
    const frames = [...animation.keyframes]
      .sort((a, b) => a.offset - b.offset)
      .map((frame) => {
        const declaration = keyframeDeclaration(node, animation, frame.value, inFlow);
        const easing = frame.easing ? ` animation-timing-function: ${EASINGS[frame.easing]};` : "";
        return `  ${num(Math.max(0, Math.min(1, frame.offset)) * 100)}% { ${declaration}${easing} }`;
      });
    ctx.styles.push(`@keyframes ${name} {\n${frames.join("\n")}\n}`);
    const iterations =
      animation.loop === true
        ? "infinite"
        : typeof animation.loop === "number"
          ? String(animation.loop)
          : "1";
    const shorthand = [
      name,
      `${num(animation.durationMs)}ms`,
      // Keyframes without their own easing use `ease`, like the canvas engine.
      "ease",
      `${num(animation.delayMs ?? 0)}ms`,
      iterations,
      animation.alternate ? "alternate" : "normal",
      "both",
    ].join(" ");
    const trigger = animation.trigger ?? "load";
    byTrigger.set(trigger, [...(byTrigger.get(trigger) ?? []), shorthand]);
  }
  const selectors: Record<string, string> = { load: "", hover: ":hover", press: ":active" };
  for (const [trigger, list] of byTrigger) {
    ctx.styles.push(`.${className}${selectors[trigger] ?? ""} { animation: ${list.join(", ")}; }`);
  }
  return className;
}

function keyframeDeclaration(
  node: CanvasNode,
  animation: CanvasAnimation,
  value: number | string,
  inFlow: boolean,
): string {
  const n = typeof value === "number" ? value : Number(value);
  switch (animation.property) {
    case "x":
      return `left: ${px(inFlow ? n - node.x : n)};`;
    case "y":
      return `top: ${px(inFlow ? n - node.y : n)};`;
    case "width":
      return `width: ${px(n)};`;
    case "height":
      return `height: ${px(n)};`;
    case "rotation":
      return `rotate: ${num(n)}deg;`;
    case "opacity":
      return `opacity: ${num(n)};`;
    case "scale":
      return `scale: ${num(n)};`;
    case "cornerRadius":
      return `border-radius: ${px(n)};`;
    case "fill":
      return node.type === "text"
        ? `color: ${cssColor(String(value))};`
        : `background-color: ${cssColor(String(value))};`;
  }
}

function tagFor(node: CanvasNode): string {
  if (node.type === "text") {
    const size = node.text?.fontSize ?? 16;
    if (size >= 32) return "h1";
    if (size >= 24) return "h2";
    if (size >= 20) return "h3";
    return "p";
  }
  const name = node.name?.toLowerCase() ?? "";
  if (node.type === "frame" || node.type === "group") {
    if (/\b(button|btn)\b/.test(name)) return "button";
    if (/\bnav(igation|bar)?\b|\bsidebar\b/.test(name)) return "nav";
    if (/\bheader\b|\btop ?bar\b/.test(name)) return "header";
    if (/\bfooter\b/.test(name)) return "footer";
    if (/\b(section|hero)\b/.test(name)) return "section";
  }
  return "div";
}

function svgMarkup(node: CanvasNode, classes: string): string {
  const fill = node.fills?.[0];
  const fillColor =
    !fill || node.type === "line"
      ? "none"
      : fill.type === "solid"
        ? fill.color
        : fill.type === "image" || fill.type === "shader"
          ? "none"
          : (fill.stops[0]?.color ?? "none");
  const svgFill = fillColor === "none" ? "none" : cssColor(fillColor);
  const stroke = node.strokes?.[0];
  const strokeAttributes = stroke
    ? ` stroke="${escapeAttribute(cssColor(stroke.color))}" stroke-width="${num(stroke.width)}" stroke-linecap="round" stroke-linejoin="round"${
        stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.map(num).join(" ")}"` : ""
      }`
    : "";
  const path =
    node.type === "ellipse"
      ? `<ellipse cx="${num(node.width / 2)}" cy="${num(node.height / 2)}" rx="${num(node.width / 2)}" ry="${num(node.height / 2)}" fill="${escapeAttribute(svgFill)}"${strokeAttributes} />`
      : `<path d="${escapeAttribute(node.path ?? "")}" fill="${escapeAttribute(svgFill)}"${strokeAttributes} />`;
  return `<svg class="${escapeAttribute(classes)}" width="${num(node.width)}" height="${num(Math.max(node.height, 1))}" viewBox="0 0 ${num(node.width)} ${num(Math.max(node.height, 1))}" fill="none" overflow="visible" xmlns="http://www.w3.org/2000/svg">${path}</svg>`;
}

function renderNode(
  ctx: ExportContext,
  node: CanvasNode,
  parent: CanvasNode | null,
  depth: number,
): string {
  const shaders = node.fills?.filter((fill) => fill.type === "shader") ?? [];
  if (shaders.length > 0) ctx.shaders.push({ nodeId: node.id, fills: shaders });
  const classes = new Classes();
  const style: string[] = [];
  const own = node.className;
  const ownTokens = new Set(own?.split(/\s+/) ?? []);
  const parentLayout = parent?.layout;
  const absoluteInFlex = Boolean(parentLayout) && ownTokens.has("absolute");
  const inFlow = Boolean(parentLayout) && !absoluteInFlex;
  const isRoot = parent === null;

  // Position.
  const children = (node.childIds ?? [])
    .map((id) => ctx.doc.nodes[id])
    .filter((child) => child !== undefined);
  const hasPositionedChildren =
    children.length > 0 &&
    (!node.layout || children.some((child) => child.className?.split(/\s+/).includes("absolute")));
  if (!isRoot && !inFlow) {
    classes.add("position", "absolute");
    classes.add("left", spacing("left", node.x));
    classes.add("top", spacing("top", node.y));
  } else if (
    hasPositionedChildren ||
    isRoot ||
    node.animations?.some((a) => a.property === "x" || a.property === "y")
  ) {
    classes.add("position", "relative");
  }
  if (inFlow) classes.add(null, "shrink-0");

  // Size.
  const text = node.type === "text" ? node.text : undefined;
  const autoWidth = text?.sizing === "auto-width";
  const autoHeight = text?.sizing === "auto-width" || text?.sizing === "auto-height";
  if (!autoWidth) classes.add("width", spacing("w", node.width));
  // Zero-height lines still need a box for their stroke to paint in.
  if (!autoHeight)
    classes.add("height", spacing("h", Math.max(node.height, node.type === "line" ? 1 : 0)));

  // Layout.
  if (node.layout && children.length > 0) {
    const layout = node.layout;
    classes.add("display", "flex");
    classes.add("direction", layout.direction === "row" ? "flex-row" : "flex-col");
    if (layout.gap) classes.add("gap", spacing("gap", layout.gap));
    if (layout.padding) {
      const [top, right, bottom, left] = layout.padding;
      if (top === right && right === bottom && bottom === left) {
        if (top) classes.add("padding", spacing("p", top));
      } else if (top === bottom && left === right) {
        if (left) classes.add("padding", spacing("px", left));
        if (top) classes.add("padding", spacing("py", top));
      } else {
        if (top) classes.add("padding", spacing("pt", top));
        if (right) classes.add("padding", spacing("pr", right));
        if (bottom) classes.add("padding", spacing("pb", bottom));
        if (left) classes.add("padding", spacing("pl", left));
      }
    }
    if (layout.align) classes.add("align", `items-${layout.align}`);
    if (layout.justify) {
      classes.add(
        "justify",
        layout.justify === "space-between" ? "justify-between" : `justify-${layout.justify}`,
      );
    }
    if (layout.wrap) classes.add("wrap", "flex-wrap");
  }

  // Fills.
  const isSvg =
    node.type === "path" ||
    node.type === "line" ||
    (node.type === "ellipse" && Boolean(node.strokes?.length));
  const fills = node.type === "text" || isSvg ? [] : (node.fills ?? []);
  if (fills.length === 1 && fills[0]!.type === "solid") {
    classes.add("bg", colorClass("bg", fills[0]!.color));
  } else if (fills.length > 0) {
    // CSS paints the first background on top; canvas fills paint last on top.
    const layers: string[] = [];
    for (let index = fills.length - 1; index >= 0; index--) {
      const fill = fills[index]!;
      if (fill.type === "solid")
        layers.push(`linear-gradient(${cssColor(fill.color)}, ${cssColor(fill.color)})`);
      else if (fill.type === "image") {
        const asset = ctx.doc.assets[fill.assetId];
        if (asset) layers.push(`url("${asset.url}")`);
      } else {
        const gradient = gradientCss(fill);
        if (gradient) layers.push(gradient);
      }
    }
    const images = fills.filter((fill) => fill.type === "image");
    if (layers.length === 1 && images.length === 0) {
      classes.add("bg", `bg-[${arbitrary(layers[0]!)}]`);
    } else if (layers.length > 0) {
      style.push(`background-image: ${layers.join(", ")}`);
      const fit = images[0]?.fit;
      if (fit) {
        classes.add(
          "bg",
          fit === "fit"
            ? "bg-contain"
            : fit === "tile"
              ? "bg-repeat"
              : fit === "stretch"
                ? "bg-size-[100%_100%]"
                : "bg-cover",
          fit === "tile" ? "" : "bg-center bg-no-repeat",
        );
      }
    }
  }

  const stroke = node.type === "path" || node.type === "line" ? undefined : node.strokes?.[0];
  if (stroke) {
    const align = stroke.align ?? "inside";
    if (align === "inside") {
      classes.add(
        "border",
        stroke.width === 1
          ? "border"
          : [2, 4, 8].includes(stroke.width)
            ? `border-${stroke.width}`
            : `border-[${px(stroke.width)}]`,
        colorClass("border", stroke.color),
        stroke.dash?.length ? "border-dashed" : "",
      );
    } else {
      classes.add(
        "outline",
        stroke.dash?.length ? "outline-dashed" : "outline",
        `outline-[${px(stroke.width)}]`,
        colorClass("outline", stroke.color),
        align === "center" ? `-outline-offset-[${px(stroke.width / 2)}]` : "",
      );
    }
  }

  // Shape.
  if (node.type === "ellipse" && !node.strokes?.length) classes.add("radius", "rounded-full");
  else if (node.cornerRadius !== undefined) {
    const size = Math.min(node.width, node.height);
    if (typeof node.cornerRadius === "number") {
      if (node.cornerRadius > 0) classes.add("radius", radius("rounded", node.cornerRadius, size));
    } else {
      const [tl, tr, br, bl] = node.cornerRadius;
      if (tl) classes.add("radius", radius("rounded-tl", tl, size));
      if (tr) classes.add("radius", radius("rounded-tr", tr, size));
      if (br) classes.add("radius", radius("rounded-br", br, size));
      if (bl) classes.add("radius", radius("rounded-bl", bl, size));
    }
  }

  // Effects.
  if (node.shadows?.length) {
    classes.add("shadow", `shadow-[${arbitrary(node.shadows.map(shadowCss).join(","))}]`);
  }
  if (node.opacity !== undefined && node.opacity < 1) {
    classes.add("opacity", `opacity-${Math.round(node.opacity * 100)}`);
  }
  if (node.rotation)
    classes.add(
      "rotate",
      node.rotation < 0
        ? `-rotate-[${num(-node.rotation)}deg]`
        : `rotate-[${num(node.rotation)}deg]`,
    );
  if (node.layerBlur) classes.add("blur", `blur-[${px(node.layerBlur)}]`);
  if (node.backgroundBlur) classes.add("backdrop", `backdrop-blur-[${px(node.backgroundBlur)}]`);
  if (node.blendMode && node.blendMode !== "normal")
    classes.add("blend", `mix-blend-${node.blendMode}`);
  if (node.clipContent) classes.add("overflow", "overflow-hidden");
  if (node.visible === false) classes.add("visibility", "hidden");

  // Text.
  if (text) {
    const size = FONT_SIZES[text.fontSize];
    classes.add("text", size ? `text-${size}` : `text-[${px(text.fontSize)}]`);
    if (text.fontFamily)
      classes.add("font", `font-['${arbitrary(text.fontFamily.replaceAll("'", ""))}']`);
    if (text.fontWeight && text.fontWeight !== 400) {
      const weight = FONT_WEIGHTS[text.fontWeight];
      classes.add("font", weight ? `font-${weight}` : `font-[${num(text.fontWeight)}]`);
    }
    if (text.fontStyle === "italic") classes.add("italic", "italic");
    if (text.lineHeight !== undefined) classes.add("leading", `leading-[${num(text.lineHeight)}]`);
    if (text.letterSpacing) classes.add("tracking", `tracking-[${px(text.letterSpacing)}]`);
    if (text.align && text.align !== "left") classes.add("textAlign", `text-${text.align}`);
    classes.add("color", colorClass("text", text.color));
    classes.add("whitespace", autoWidth ? "whitespace-pre" : "whitespace-pre-wrap");
    if (text.verticalAlign && text.verticalAlign !== "top" && !autoHeight) {
      classes.add("display", "flex");
      classes.add("direction", "flex-col");
      classes.add("justify", text.verticalAlign === "middle" ? "justify-center" : "justify-end");
    }
  }

  const animationClass = animationCss(ctx, node, inFlow || isRoot);
  if (animationClass) classes.add(null, animationClass);

  const classAttribute = classes.render(own, inFlow ? (parentLayout?.direction ?? null) : null);
  const indent = "  ".repeat(depth);
  const nameAttribute = node.name ? ` data-name="${escapeAttribute(node.name)}"` : "";
  if (isSvg) {
    return `${indent}${svgMarkup(node, classAttribute)}`;
  }
  if (node.type === "image") {
    const fill = node.fills?.find((paint) => paint.type === "image");
    const asset = fill?.type === "image" ? ctx.doc.assets[fill.assetId] : undefined;
    if (asset) {
      return `${indent}<img class="${escapeAttribute(`${classAttribute} object-cover`)}" src="${escapeAttribute(asset.url)}" alt="${escapeAttribute(node.name ?? "")}" />`;
    }
  }
  const tag = tagFor(node);
  const styleAttribute = style.length > 0 ? ` style="${escapeAttribute(style.join("; "))}"` : "";
  const open = `${indent}<${tag} class="${escapeAttribute(classAttribute)}"${styleAttribute}${nameAttribute}>`;
  if (text) return `${open}${escapeHtml(text.content)}</${tag}>`;
  if (children.length === 0) return `${open}</${tag}>`;
  const inner = children.map((child) => renderNode(ctx, child, node, depth + 1)).join("\n");
  return `${open}\n${inner}\n${indent}</${tag}>`;
}

/**
 * Exports `nodeId` (or every top-level node) as HTML with Tailwind classes.
 * Animations add a `<style>` block with `@keyframes`.
 */
export function exportCanvasHtml(doc: CanvasDocument, nodeId?: string): string {
  const ctx: ExportContext = { doc, styles: [], shaders: [] };
  let body: string;
  if (nodeId !== undefined) {
    const node = doc.nodes[nodeId];
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    body = renderNode(ctx, node, null, 0);
  } else {
    const roots = doc.rootIds.map((id) => doc.nodes[id]).filter((node) => node !== undefined);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const root of roots) {
      minX = Math.min(minX, root.x);
      minY = Math.min(minY, root.y);
      maxX = Math.max(maxX, root.x + root.width);
      maxY = Math.max(maxY, root.y + root.height);
    }
    if (roots.length === 0) {
      minX = minY = maxX = maxY = 0;
    }
    // Shift roots so the board starts at 0,0 and render them as positioned children.
    const board: CanvasNode = {
      id: "__board",
      type: "group",
      parentId: null,
      name: doc.name,
      x: 0,
      y: 0,
      width: maxX - minX,
      height: maxY - minY,
      childIds: roots.map((root) => root.id),
    };
    const shifted: CanvasDocument = {
      ...doc,
      nodes: {
        ...doc.nodes,
        __board: board,
        ...Object.fromEntries(
          roots.map((root) => [root.id, { ...root, x: root.x - minX, y: root.y - minY }]),
        ),
      },
    };
    body = renderNode({ ...ctx, doc: shifted }, board, null, 0);
  }
  const style = ctx.styles.length > 0 ? `<style>\n${ctx.styles.join("\n")}\n</style>\n` : "";
  const shaders =
    ctx.shaders.length > 0
      ? `<!-- Shader fills require the canvas WebGL runtime; source and uniforms are preserved below. -->\n<script type="application/json" data-t3-canvas-shaders>${JSON.stringify(ctx.shaders).replaceAll("<", "\\u003c")}</script>\n`
      : "";
  return `${style}${body}\n${shaders}`;
}
