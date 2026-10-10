import type rehypeKatex from "rehype-katex";
import { createChatMathPlugins } from "./markdownMath";

type Root = Parameters<ReturnType<typeof rehypeKatex>>[0];
type Node = Root["children"][number];
type Element = Extract<Node, { type: "element" }>;

function childrenOf(node: Node): Node[] {
  return "children" in node ? node.children : [];
}

function findElement(node: Node, tagName: string): Element | undefined {
  if (node.type === "element" && node.tagName === tagName) return node;
  for (const child of childrenOf(node)) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
}

function grouped(value: string): string {
  return /^[\p{L}\p{N}]+$/u.test(value) ? value : `(${value})`;
}

/** Linearize semantic MathML rather than guessing at TeX command boundaries. */
function readableMath(node: Node): string {
  if (node.type === "text") return node.value.replace(/[\u2061-\u2064]/g, "");
  if (node.type !== "element") return "";
  const children = node.children;
  const values = children.map(readableMath);
  const base = values[0] ?? "";
  switch (node.tagName) {
    case "annotation":
    case "annotation-xml":
      return "";
    case "semantics":
      return base;
    case "mfrac":
      return `${grouped(base)} / ${grouped(values[1] ?? "")}`;
    case "msqrt":
      return `sqrt(${values.join(" ")})`;
    case "mroot":
      return `root(${values[1]}, ${base})`;
    case "msup":
      return `${grouped(base)}^${grouped(values[1] ?? "")}`;
    case "msub":
      return `${grouped(base)}[${values[1]}]`;
    case "msubsup":
    case "munderover": {
      const operator =
        base === "∫" ? "integral" : base === "∑" ? "sum" : base === "∏" ? "product" : base;
      if (base === "∫" || base === "∑" || base === "∏") {
        return `${operator}[${values[1]} to ${values[2]}]`;
      }
      return node.tagName === "msubsup"
        ? `${grouped(base)}[${values[1]}]^${grouped(values[2] ?? "")}`
        : `${base} (with ${values[1]} below and ${values[2]} above)`;
    }
    case "munder":
      return `${base}(${values[1]})`;
    case "mover":
      return `${base} (with ${values[1]} above)`;
    case "mrow": {
      const table = children.find(
        (child) => child.type === "element" && child.tagName === "mtable",
      );
      if (base === "{" && table) {
        return `cases:\n${childrenOf(table)
          .map((row) => {
            const cells = childrenOf(row).map(readableMath);
            return `${cells[0]} if ${cells.slice(1).join(" ")}`;
          })
          .join("\n")}`;
      }
      return values
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
    }
    case "mtable": {
      const rows = children.map((row) => childrenOf(row).map(readableMath));
      const widths = rows.reduce<number[]>((result, row) => {
        row.forEach((cell, index) => {
          result[index] = Math.max(result[index] ?? 0, cell.length);
        });
        return result;
      }, []);
      return `\n${rows
        .map((row) =>
          row
            .map((cell, index) => cell.padEnd(widths[index] ?? 0))
            .join("  ")
            .trimEnd(),
        )
        .join("\n")}\n`;
    }
    case "mspace":
    case "mphantom":
      return " ";
    default:
      return values
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
  }
}

function rehypeReadableMath(): ReturnType<typeof rehypeKatex> {
  return (tree) => {
    visit(tree);
    function visit(parent: Root | Element) {
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (node?.type !== "element") continue;
        const classes = node.properties.className;
        const display = Array.isArray(classes) && classes.includes("katex-display");
        const inline = Array.isArray(classes) && classes.includes("katex");
        if (Array.isArray(classes) && classes.includes("katex-error")) {
          node.properties.className = ["math-readable-inline"];
          delete node.properties.style;
          continue;
        }
        if (!display && !inline) {
          visit(node);
          continue;
        }
        const math = findElement(node, "math");
        const annotation = findElement(node, "annotation");
        if (!math || !annotation) continue;
        const displayMode = display || math.properties.display === "block";
        const source = annotation.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("");
        parent.children[index] = {
          type: "element",
          tagName: "span",
          properties: {
            className: [displayMode ? "math-readable-display" : "math-readable-inline"],
            dataMarkdownCopy: displayMode ? `\\[\n${source}\n\\]` : `\\(${source}\\)`,
          },
          children: [{ type: "text", value: readableMath(math).trim() }],
        };
      }
    }
  };
}

const mathmlPlugins = createChatMathPlugins("mathml");

export const CHAT_MATH_PLUGINS = {
  ...mathmlPlugins,
  rehype: [...mathmlPlugins.rehype, rehypeReadableMath],
  literalRehype: [...mathmlPlugins.literalRehype, rehypeReadableMath],
};
