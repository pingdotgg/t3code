import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const FrontmatterDocument = fromYaml(Schema.Record(Schema.String, Schema.Json));
const decodeFrontmatterDocument = Schema.decodeUnknownOption(FrontmatterDocument);
const encodeYamlValue = Schema.encodeSync(fromYaml(Schema.Json));

export type MarkdownFrontmatterValue =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "list";
      readonly items: ReadonlyArray<string>;
    }
  | { readonly kind: "yaml"; readonly source: string };

export interface MarkdownFrontmatterEntry {
  readonly key: string;
  readonly value: MarkdownFrontmatterValue;
}

export interface MarkdownFrontmatter {
  readonly body: string;
  readonly bodyOffset: number;
  readonly entries: ReadonlyArray<MarkdownFrontmatterEntry>;
}

function displayFrontmatterValue(value: Schema.Json): MarkdownFrontmatterValue {
  if (value === null) {
    return { kind: "text", text: "null" };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "text", text: String(value) };
  }
  if (Array.isArray(value) && value.length > 0) {
    const items: Array<string> = [];
    for (const item of value) {
      if (item === null) {
        items.push("null");
      } else if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      ) {
        items.push(String(item));
      } else {
        return { kind: "yaml", source: encodeYamlValue(value).trimEnd() };
      }
    }
    return { kind: "list", items };
  }
  return { kind: "yaml", source: encodeYamlValue(value).trimEnd() };
}

export function parseMarkdownFrontmatter(markdown: string): MarkdownFrontmatter {
  const unparsed: MarkdownFrontmatter = { body: markdown, bodyOffset: 0, entries: [] };
  const openingLineEnd = markdown.indexOf("\n");
  if (openingLineEnd === -1) {
    return unparsed;
  }

  const openingLine = markdown.slice(0, openingLineEnd).replace(/\r$/, "");
  if (openingLine !== "---") {
    return unparsed;
  }

  const yamlStart = openingLineEnd + 1;
  let lineStart = yamlStart;
  while (lineStart <= markdown.length) {
    const nextLineEnd = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineEnd === -1 ? markdown.length : nextLineEnd;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (line === "---") {
      const decoded = decodeFrontmatterDocument(markdown.slice(yamlStart, lineStart));
      if (Option.isNone(decoded)) {
        return unparsed;
      }

      const entries = Object.entries(decoded.value).map(([key, value]) => ({
        key,
        value: displayFrontmatterValue(value),
      }));
      const bodyOffset = nextLineEnd === -1 ? lineEnd : nextLineEnd + 1;
      return {
        body: markdown.slice(bodyOffset),
        bodyOffset,
        entries,
      };
    }

    if (nextLineEnd === -1) {
      break;
    }
    lineStart = nextLineEnd + 1;
  }

  return unparsed;
}
