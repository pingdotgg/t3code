// @effect-diagnostics nodeBuiltinImport:off - a plain test that scans the source tree once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { THEME_CSS_HOOKS } from "@t3tools/shared/themeCss";
import { expect, it } from "vite-plus/test";

const sourceDirectory = import.meta.dirname;
const source = NodeFS.readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(tsx?|css)$/.test(file) && !file.includes(".test."))
  .map((file) => NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8"))
  .join("\n");

/** How the selector's hook is written in source: an attribute, a slot value, or a class name. */
function sourcePattern(selector: string): RegExp {
  const slot = /^\[data-slot="([a-z-]+)"\]$/.exec(selector)?.[1];
  if (slot) return new RegExp(`data-slot["']?\\s*[:=]\\s*["']${slot}["']`);
  const attribute = /^\[(data-[a-z-]+)/.exec(selector)?.[1];
  return new RegExp(`\\b${attribute ?? selector.slice(1)}\\b`);
}

// Theme CSS and the agent guide rely on these selectors. Rename one in the guide too.
it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))(
  "%s is still in the web source",
  (selector) => {
    expect(source).toMatch(sourcePattern(selector));
  },
);
