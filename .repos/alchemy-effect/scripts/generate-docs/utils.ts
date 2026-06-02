import * as path from "node:path";

import { Node, type JSDoc } from "ts-morph";

import type {
  ExampleDoc,
  ExampleSection,
  JSDocInfo,
  PropertyDoc,
} from "./types.ts";

export const repoRoot = path.resolve(import.meta.dir, "../..");
export const packageRoot = path.join(repoRoot, "alchemy");
export const srcRoot = path.join(packageRoot, "src");
export const docsRoot = path.join(packageRoot, "docs");
export const tsConfigPath = path.join(packageRoot, "tsconfig.json");

export function toPosix(filePath: string) {
  return filePath.split(path.sep).join("/");
}

export function relativeSourcePath(filePath: string) {
  return toPosix(path.relative(packageRoot, filePath));
}

export function titleFromRelativePath(relativePath: string) {
  const baseName = path.basename(relativePath, ".ts");
  if (baseName !== "index") {
    return baseName;
  }
  const directory = path.dirname(relativePath);
  return directory === "." ? "API Reference" : path.basename(directory);
}

export function labelFromDocRelativePath(relativePath: string) {
  return titleFromRelativePath(relativePath);
}

export function lowerPathKey(relativePath: string) {
  return toPosix(relativePath).toLowerCase();
}

export function canonicalScore(relativePath: string) {
  const baseName = path.basename(relativePath);
  const uppercaseCount = [...relativePath].filter(
    (char) => char >= "A" && char <= "Z",
  ).length;
  return (
    (baseName === "index.ts" ? 1000 : 0) +
    (/^[A-Z]/.test(baseName) ? 100 : 0) +
    uppercaseCount * 5 +
    (relativePath === relativePath.toLowerCase() ? -20 : 0)
  );
}

export function escapeMarkdown(value: string) {
  return value.replace(/\|/g, "\\|");
}

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function formatTypeText(value: string | undefined) {
  return value
    ? value
        .replace(/\/\*\*[\s\S]*?\*\//g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*$/gm, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "unknown";
}

export function truncateInline(value: string, maxLength = 120) {
  const normalized = formatTypeText(value);
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

export function lowerCamel(name: string) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function docOutputPath(relativePath: string) {
  return path.join(docsRoot, relativePath.replace(/\.ts$/, ".md"));
}

export function relativeDocLink(fromDocPath: string, toDocPath: string) {
  return toPosix(path.relative(path.dirname(fromDocPath), toDocPath));
}

/**
 * Convert JSDoc `{@link url | label}` into standard markdown links.
 * Absolute `https://alchemy.run/...` URLs are rewritten to relative
 * paths so the links work in any deployment (localhost, preview, prod).
 */
function resolveJSDocLinks(text: string): string {
  return text.replace(
    /\{@link\s+(https?:\/\/alchemy\.run(\/[^\s|}]*))\s*\|\s*([^}]+)\}/g,
    (_match, _url, pathname, label) => `[${label.trim()}](${pathname})`,
  );
}

export function cleanDocComment(raw: string) {
  const cleaned = raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
  return resolveJSDocLinks(cleaned);
}

function getJsDocBlocks(node: Node) {
  const getter = (node as Node & { getJsDocs?: () => JSDoc[] }).getJsDocs;
  return getter ? getter.call(node) : [];
}

export function getJSDocInfo(node: Node): JSDocInfo {
  const docs = getJsDocBlocks(node);
  if (docs.length === 0) {
    return { sections: [] };
  }

  const clean = cleanDocComment(docs.map((doc) => doc.getText()).join("\n"));
  const lines = clean.split("\n");
  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];

  let defaultValue: string | undefined;
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleDoc | undefined;

  const ensureSection = (title: string) => {
    const section = { title, examples: [] };
    sections.push(section);
    currentSection = section;
    return section;
  };

  const flushExample = () => {
    if (!currentExample) {
      return;
    }
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = ensureSection("Examples");
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  for (const line of lines) {
    const tag = line.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = rest.trim();
      switch (name) {
        case "default":
          defaultValue = value || undefined;
          break;
        case "section":
          flushExample();
          ensureSection(value || "Examples");
          break;
        case "example":
          flushExample();
          currentExample = {
            title: value || "Example",
            body: "",
          };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    }
  }

  flushExample();

  const summary = normalizeWhitespace(
    summaryLines.join("\n").replace(/```[\s\S]*?```/g, ""),
  );

  return {
    summary: summary || undefined,
    defaultValue,
    sections,
  };
}

export function getSummary(node: Node) {
  return getJSDocInfo(node).summary;
}

export function getDefaultValue(node: Node) {
  return getJSDocInfo(node).defaultValue;
}

export function guessExampleValue(property: PropertyDoc) {
  const type = property.type;

  const literal = type.match(/"([^"]+)"|'([^']+)'/);
  if (literal) {
    return JSON.stringify(literal[1] ?? literal[2]);
  }
  if (/ScalarAttributeType/.test(type)) {
    return `{ pk: "S" }`;
  }
  if (/Record</.test(type)) {
    return "{}";
  }
  if (/\[\]$/.test(type) || /Array</.test(type)) {
    return "[]";
  }
  if (/boolean/i.test(type)) {
    return "true";
  }
  if (/number/i.test(type)) {
    return "1";
  }
  if (/string/i.test(type) || /Name|Arn|Id|Url|Key|Path/.test(type)) {
    return JSON.stringify(property.name);
  }
  return "undefined as any";
}
