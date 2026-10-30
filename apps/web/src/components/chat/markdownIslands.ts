import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
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
  const html = toHtml(
    node.children.map((child) => transformStatic(child, options.staticElement)),
    { allowDangerousHtml: false },
  );
  innerHtmlCache.set(node, { variant: options.variant, html });
  return html;
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

function containsIsland(node: Element, isIsland: MarkdownIslandOptions["isIsland"]): boolean {
  for (const child of node.children) {
    if (child.type === "element" && (isIsland(child) || containsIsland(child, isIsland))) {
      return true;
    }
  }
  return false;
}

function renderContent(
  node: RootContent,
  key: number,
  options: MarkdownIslandOptions,
): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  if (options.isIsland(node)) {
    return createElement(
      ReactFragment,
      { key },
      toJsxRuntime(node, jsxOptions(options.components)),
    );
  }
  const element = options.staticElement(node);
  const props: Record<string, unknown> = { ...shallowProps(element, options.components), key };
  if (containsIsland(element, options.isIsland)) {
    return createElement(
      element.tagName,
      props,
      ...element.children.map((child, index) => renderContent(child, index, options)),
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
  return tree.children.map((child, index) => renderContent(child, index, options));
}

export function withProperties(node: Element, properties: Properties): Element {
  return { ...node, properties: { ...node.properties, ...properties } };
}
