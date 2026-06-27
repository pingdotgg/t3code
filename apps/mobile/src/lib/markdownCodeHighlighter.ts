import {
  defaultHighlighter,
  type HighlightedToken,
  type TokenType,
} from "react-native-nitro-markdown";

const YAML_LANGUAGES = new Set(["yaml", "yml"]);
const YAML_KEYWORDS = new Set(["false", "no", "null", "off", "on", "true", "yes", "~"]);
const YAML_PUNCTUATION = new Set([":", "[", "]", "{", "}", ","]);

function yamlStructuralIndex(line: string, target: ":" | "#"): number {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) {
      if (quote === "'" && line[index + 1] === "'") {
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }
    if (quote === null && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (quote !== null || character !== target) {
      continue;
    }
    if (target === "#") {
      if (index === 0 || /\s/.test(line[index - 1] ?? "")) return index;
      continue;
    }
    if (index === line.length - 1 || /\s/.test(line[index + 1] ?? "")) return index;
  }

  return -1;
}

function yamlBodyTokens(line: string): HighlightedToken[] {
  const keySeparator = yamlStructuralIndex(line, ":");
  const tokens: HighlightedToken[] = [];
  const tokenPattern =
    /("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?|[&*!][A-Za-z0-9_.-]+|[A-Za-z_][A-Za-z0-9_.-]*|[:[\]{},]|[-?|>]+|\s+|.)/g;

  for (const match of line.matchAll(tokenPattern)) {
    const text = match[0];
    const start = match.index;
    const end = start + text.length;
    let type: TokenType = "default";

    if (/^\s+$/.test(text)) {
      type = "default";
    } else if (YAML_PUNCTUATION.has(text)) {
      type = "punctuation";
    } else if (/^[-?|>]+$/.test(text) || /^[&*!]/.test(text)) {
      type = "operator";
    } else if (/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) {
      type = "number";
    } else if (YAML_KEYWORDS.has(text.toLowerCase())) {
      type = "keyword";
    } else if (keySeparator >= 0 && end <= keySeparator) {
      type = "type";
    } else if (/^["']/.test(text) || /^[A-Za-z_]/.test(text)) {
      type = "string";
    }

    tokens.push({ text, type });
  }

  return tokens;
}

function highlightYaml(code: string): HighlightedToken[] {
  const lines = code.split("\n");
  const tokens: HighlightedToken[] = [];

  lines.forEach((line, index) => {
    const commentStart = yamlStructuralIndex(line, "#");
    const body = commentStart >= 0 ? line.slice(0, commentStart) : line;
    tokens.push(...yamlBodyTokens(body));
    if (commentStart >= 0) {
      tokens.push({ text: line.slice(commentStart), type: "comment" });
    }
    if (index < lines.length - 1) {
      tokens.push({ text: "\n", type: "default" });
    }
  });

  return tokens;
}

export function highlightMarkdownCode(language: string, code: string): HighlightedToken[] {
  return YAML_LANGUAGES.has(language.toLowerCase())
    ? highlightYaml(code)
    : defaultHighlighter(language, code);
}
