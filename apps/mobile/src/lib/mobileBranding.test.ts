import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { MOBILE_APP_NAME, MOBILE_APP_NAME_SUFFIX, resolveMobileStageLabel } from "./mobileBranding";

const MOBILE_ROOT = NodePath.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

/** Lines that still say "T3 Code" outside a comment. */
function upstreamBrandLines(file: string): string[] {
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
      const beforeComment = line.replace(/\s\/\/.*$/, "");
      return beforeComment.includes("T3 Code")
        ? [`${NodePath.relative(MOBILE_ROOT, file)}:${index + 1}`]
        : [];
    });
}

describe("mobile branding", () => {
  it("names the fork's app T3 Agents", () => {
    expect(MOBILE_APP_NAME).toBe("T3 Agents");
    expect(MOBILE_APP_NAME_SUFFIX).toBe("Agents");
  });

  it("shows no stage badge on release builds", () => {
    expect(resolveMobileStageLabel("production")).toBeNull();
    expect(resolveMobileStageLabel(undefined)).toBeNull();
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  });

  // Upstream syncs bring "T3 Code" copy back; user-visible names go through MOBILE_APP_NAME.
  it("shows no upstream T3 Code name in the app", () => {
    const files = [
      ...sourceFiles(NodePath.join(MOBILE_ROOT, "src")),
      NodePath.join(MOBILE_ROOT, "app.config.ts"),
    ];
    expect(files.flatMap(upstreamBrandLines)).toEqual([]);
  });
});
