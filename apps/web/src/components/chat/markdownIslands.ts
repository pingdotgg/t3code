import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { find, html as htmlSchema } from "property-information";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { createElement, Fragment as ReactFragment, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

export interface MarkdownIslandOptions {
  readonly components: Partial<Components>;
  /** Elements that need their React component; everything else renders as static HTML. */
  readonly isIsland: (node: Element) => boolean;
  /** What a static element's component would have added, or the node itself when nothing. */
  readonly staticElement: (node: Element) => Element;
  /** Separates static HTML that `staticElement` renders differently, such as a heading offset. */
  readonly variant: string;
}

const VOID_ELEMENTS = new Set(
  "area base br col embed hr img input link meta source track wbr".split(" "),
);

const jsxOptions = (components: Partial<Components>) =>
  ({
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  }) as const;

// Static HTML depends only on the cached, immutable tree and the variant.
const innerHtmlCache = new WeakMap<Element, { variant: string; html: string }>();

function transformStatic(
  node: ElementContent,
  staticElement: MarkdownIslandOptions["staticElement"],
): ElementContent {
  if (node.type !== "element") return node;
  const element = staticElement(node);
  let children: ElementContent[] | undefined;
  for (let index = 0; index < element.children.length; index++) {
    const child = element.children[index]!;
    const next = transformStatic(child, staticElement);
    if (next !== child) {
      children ??= element.children.slice();
      children[index] = next;
    }
  }
  return children ? { ...element, children } : element;
}

function innerHtml(node: Element, options: MarkdownIslandOptions): string {
  const cached = innerHtmlCache.get(node);
  if (cached?.variant === options.variant) return cached.html;
  let html = "";
  for (const child of node.children) {
    html += serialize(transformStatic(child, options.staticElement));
  }
  innerHtmlCache.set(node, { variant: options.variant, html });
  return html;
}

interface AttributeInfo {
  readonly name: string;
  readonly boolean: boolean;
  readonly separator: string;
}

const attributeInfo = new Map<string, AttributeInfo>();

function infoFor(property: string): AttributeInfo {
  let info = attributeInfo.get(property);
  if (!info) {
    const found = find(htmlSchema, property);
    info = {
      name: found.attribute,
      boolean: found.boolean || found.overloadedBoolean,
      separator: found.commaSeparated ? ", " : " ",
    };
    attributeInfo.set(property, info);
  }
  return info;
}

const escapeText = (value: string) =>
  value.includes("&") || value.includes("<") || value.includes(">")
    ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : value;
const escapeAttribute = (value: string) =>
  value.includes("&") || value.includes('"')
    ? value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    : value;

/** HTML for the elements and text this pipeline builds; the DOM matches hast-util-to-html's. */
function serialize(node: ElementContent): string {
  if (node.type === "text") return escapeText(node.value);
  if (node.type !== "element") return "";
  let html = `<${node.tagName}`;
  const { properties } = node;
  for (const key in properties) {
    const value = properties[key];
    if (value === null || value === undefined || value === false || Number.isNaN(value)) continue;
    const info = infoFor(key);
    if (info.boolean && value) {
      html += ` ${info.name}`;
      continue;
    }
    const text = Array.isArray(value)
      ? value.join(info.separator)
      : value === true
        ? ""
        : String(value);
    html += ` ${info.name}="${escapeAttribute(text)}"`;
  }
  html += ">";
  if (VOID_ELEMENTS.has(node.tagName)) return html;
  for (const child of node.children) html += serialize(child);
  return `${html}</${node.tagName}>`;
}

/** React props for an element, converted as hast-util-to-jsx-runtime converts them. */
function shallowProps(node: Element, components: Partial<Components>): Record<string, unknown> {
  const element = toJsxRuntime(
    { ...node, children: [] },
    { ...jsxOptions(components), components: {}, passNode: false },
  ) as { props: Record<string, unknown> };
  const { children: _children, ...props } = element.props;
  return props;
}

interface Plan {
  readonly islands: Set<Element>;
  /** Elements with an island somewhere below them. */
  readonly ancestors: Set<Element>;
}

function renderContent(
  node: RootContent,
  key: number,
  options: MarkdownIslandOptions,
  plan: Plan,
): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  if (plan.islands.has(node)) {
    return createElement(
      ReactFragment,
      { key },
      toJsxRuntime(node, jsxOptions(options.components)),
    );
  }
  const element = options.staticElement(node);
  const props: Record<string, unknown> = { ...shallowProps(element, options.components), key };
  if (plan.ancestors.has(node)) {
    return createElement(
      element.tagName,
      props,
      ...element.children.map((child, index) => renderContent(child, index, options, plan)),
    );
  }
  if (element.children.length > 0 && !VOID_ELEMENTS.has(element.tagName)) {
    props.dangerouslySetInnerHTML = { __html: innerHtml(node, options) };
  }
  return createElement(element.tagName, props);
}

/**
 * Renders a hast tree with React only on the path to elements that need a component: subtrees
 * without one become static HTML, which the browser builds without React reconciling each node.
 */
export function renderHastWithIslands(tree: Root, options: MarkdownIslandOptions): ReactNode {
  // The same elements again let React skip the block; islands still follow their context.
  let signature = options.variant;
  const plan: Plan = { islands: new Set(), ancestors: new Set() };
  const visit = (node: Root | Element): boolean => {
    let below = false;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const island = options.isIsland(child);
      signature += island ? "1" : "0";
      if (island) {
        plan.islands.add(child);
        below = true;
        continue;
      }
      if (visit(child)) {
        plan.ancestors.add(child);
        below = true;
      }
    }
    return below;
  };
  visit(tree);
  const cached = renderedTrees.get(tree);
  if (cached?.signature === signature && cached.components === options.components) {
    return cached.node;
  }
  const node = tree.children.map((child, index) => renderContent(child, index, options, plan));
  renderedTrees.set(tree, { signature, components: options.components, node });
  return node;
}

const renderedTrees = new WeakMap<
  Root,
  { signature: string; components: Partial<Components>; node: ReactNode }
>();

export function withProperties(node: Element, properties: Properties): Element {
  return { ...node, properties: { ...node.properties, ...properties } };
}
