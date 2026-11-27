// Turns an OpenUI Lang program from an agent into a self-contained page for html_render.
// The page carries the whole renderer: Chromium does not cache what a sandboxed frame loads,
// so a shared script would be downloaded again for every frame anyway.
import { createParser } from "@openuidev/lang-core";

import spec from "./openUiSpec.generated.json" with { type: "json" };

export const OPENUI_ASSET_FILES = {
  script: "openui-bundle.min.js",
  styles: "openui-styles.css",
} as const;

export interface OpenUiAssets {
  readonly script: string;
  readonly styles: string;
}

const MAX_PROBLEMS = 10;

const parser = createParser(spec.schema as Parameters<typeof createParser>[0], spec.root);

export const openUiGuide = `OpenUI draws a display-only page of cards, tables, and charts from a short program. Pass the program as openui to html_preview, then to html_render. T3 Code supplies the theme and layout.

Syntax:
- One statement per line: name = Expression
- Define root first: root = Card([...])
- Expressions: "strings" (double quotes, backslash escapes), numbers, true, false, null, [arrays], {objects}, or Component(arguments).
- Arguments are positional, in signature order. ? marks an optional one: leave off trailing ones, pass null to skip one. Never write name: value in a call.
- A name may be used before the line that defines it. Every name except root must be reachable from root.
- There are no forms, buttons, Query, or Mutation. Put the data in the program.

Example:
root = Card([header, chart, jobs])
header = CardHeader("Build times", "Last four weeks, in minutes")
chart = LineChart(["W1", "W2", "W3", "W4"], [Series("CI", [14, 12, 11, 9])])
jobs = Table([Col("Job", ["lint", "test"]), Col("Minutes", [2, 7], "number")])

Components:
${spec.signatures}`;

/** What stops the program from rendering as written; empty when it is good. */
export function openUiProblems(program: string): ReadonlyArray<string> {
  const { root, meta, queryStatements, mutationStatements } = parser.parse(program);
  const problems = meta.errors
    .filter((error) => error.severity !== "warning")
    .map((error) => {
      const where = error.statementId === undefined ? "" : `${error.statementId}: `;
      // The parser's own message for this lists every component.
      return error.code === "unknown-component"
        ? `${where}${error.component} is not an available component.`
        : `${where}${error.component}${error.path}: ${error.message}`;
    });
  if (meta.incomplete) problems.push("The program ends in the middle of a statement.");
  if (meta.unresolved.length > 0) {
    problems.push(`Used but never defined: ${meta.unresolved.join(", ")}.`);
  }
  if (meta.orphaned.length > 0) {
    problems.push(`Defined but not reachable from root: ${meta.orphaned.join(", ")}.`);
  }
  if (queryStatements.length > 0 || mutationStatements.length > 0) {
    problems.push("Query and Mutation are not available. Put the data in the program.");
  }
  if (root === null && problems.length === 0) {
    problems.push("Nothing to show: start with root = Card([...]).");
  }
  return problems.slice(0, MAX_PROBLEMS);
}

// html_render refuses sizes that follow the frame height, and the stylesheet has a few.
const fixViewportHeights = (css: string) =>
  css.replace(
    /(\d+(?:\.\d+)?)[sld]?v(?:h|b|max)(?![\w-])/gi,
    (_, amount: string) => `${Math.round(Number(amount) * 6)}px`,
  );

// Maps OpenUI's colors and fonts onto the theme variables every html_render page receives. The
// components also expect the host app to size boxes by their border, or some overflow sideways.
// Safari drops chart axis labels onto the bars unless each tspan takes its text's baseline.
const THEME_CSS = `:where(*,*::before,*::after){box-sizing:border-box}
#openui-root{overflow-x:clip}
#openui-root tspan{dominant-baseline:inherit}
:root:root:root{
--openui-background:var(--background);
--openui-foreground:var(--card);
--openui-popover-background:var(--popover);
--openui-sunk-light:color-mix(in oklab,var(--foreground) 2%,transparent);
--openui-sunk:var(--muted);
--openui-text-neutral-primary:var(--foreground);
--openui-text-neutral-secondary:var(--muted-foreground);
--openui-text-neutral-link:var(--primary);
--openui-text-brand:var(--primary);
--openui-border-default:var(--border);
--openui-border-interactive:var(--input);
--openui-interactive-accent-default:var(--primary);
--openui-text-accent-primary:var(--primary-foreground);
}`;

// The program travels as text inside a script element, where only "</" and "<!" could end or
// confuse the element. One backslash goes in and the page takes it out again.
const escapeProgram = (program: string) => program.replace(/<(\\*)([/!])/g, "<$1\\$2");
const UNESCAPE_PROGRAM = String.raw`.replace(/<\\(\\*)([\/!])/g,"<$1$2")`;

// A page loaded over plain HTTP, as on a phone on the local network, has no crypto.randomUUID,
// and the renderer calls it.
const UUID_SCRIPT = `if(!crypto.randomUUID){var n=0;crypto.randomUUID=function(){return "openui-"+ ++n}}`;

const MOUNT_SCRIPT = `(function(){var ui=window.__OpenUI,root=document.documentElement,theme=document.getElementById("t3-theme");
function appearance(){root.setAttribute("data-openui-theme",getComputedStyle(root).colorScheme.indexOf("light")>-1?"light":"dark")}
appearance();if(theme)new MutationObserver(appearance).observe(theme,{childList:true,characterData:true,subtree:true});
matchMedia("(prefers-color-scheme: light)").addEventListener("change",appearance);
var program=document.getElementById("openui-program").textContent${UNESCAPE_PROGRAM};
ui.createRoot(document.getElementById("openui-root")).render(ui.React.createElement(ui.Renderer,{response:program,library:ui.openuiChatLibrary,isStreaming:false,publishObservability:false,onError:function(errors){errors.forEach(function(error){console.warn(error.message)})}}));})();`;

export function openUiPage(program: string, assets: OpenUiAssets): string {
  const styles = fixViewportHeights(assets.styles)
    .replaceAll('"Inter", sans-serif', "var(--font-sans)")
    .replaceAll('"SFMono-Regular", Menlo, monospace', "var(--font-mono)");
  return [
    "<!doctype html><html><head>",
    "<style>",
    styles,
    THEME_CSS,
    '</style></head><body><div id="openui-root"></div>',
    '<script type="text/openui" id="openui-program">',
    escapeProgram(program),
    "</script><script>",
    UUID_SCRIPT,
    "</script><script>",
    assets.script,
    "</script><script>",
    MOUNT_SCRIPT,
    "</script></body></html>",
  ].join("");
}
