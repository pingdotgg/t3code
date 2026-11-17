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

/** How each part of the selector is written in source: a slot value, an attribute, or a class. */
function sourcePatterns(selector: string): RegExp[] {
  return Array.from(
    selector.matchAll(/\[data-slot="([a-z-]+)"\]|\[((?:data|aria)-[a-z-]+)|\.([a-z-]+)/g),
    ([, slot, attribute, className]) =>
      slot
        ? new RegExp(`data-slot["']?\\s*[:=]\\s*["']${slot}["']`)
        : new RegExp(`\\b${attribute ?? className}\\b`),
  );
}

// Theme CSS and the agent guide rely on these selectors. Rename one in the guide too.
it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))(
  "%s is still in the web source",
  (selector) => {
    const patterns = sourcePatterns(selector);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(source).toMatch(pattern);
  },
);
