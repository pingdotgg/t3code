import React from "react";
import { Box, Text } from "ink";

interface Props {
  children: string;
}

export const MarkdownText: React.FC<Props> = ({ children }) => {
  const blocks = parseBlocks(children.trim());
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <RenderBlock key={i} block={block} />
      ))}
    </Box>
  );
};

// ── Block types ────────────────────────────────────────────────────────────

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" }
  | { kind: "list_item"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "blank" }
  | { kind: "paragraph"; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: headingMatch[2]! });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // List item
    const listMatch = line.match(/^(\s*[-*+]|\s*\d+\.)\s+(.+)/);
    if (listMatch) {
      blocks.push({ kind: "list_item", text: listMatch[2]! });
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }

    // Table — collect header + separator + data rows
    if (line.includes("|")) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i]!.includes("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      const parsed = parseTable(tableLines);
      if (parsed) {
        blocks.push(parsed);
      } else {
        for (const tl of tableLines) {
          blocks.push({ kind: "paragraph", text: tl });
        }
      }
      continue;
    }

    // Plain paragraph
    blocks.push({ kind: "paragraph", text: line });
    i++;
  }

  return blocks;
}

// ── Table parser ──────────────────────────────────────────────────────────

function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function parseTable(
  lines: string[],
): Extract<Block, { kind: "table" }> | null {
  if (lines.length < 2) return null;
  const headers = parseTableRow(lines[0]!);
  // Second line must be a separator (e.g. |---|---|)
  const isSep = /^[\s|:-]+$/.test(lines[1]!);
  if (!isSep) return null;
  const rows = lines.slice(2).map(parseTableRow);
  return { kind: "table", headers, rows };
}

// ── Inline formatting ──────────────────────────────────────────────────────

// Splits a string into runs of plain text and inline-code spans
function parseInline(
  text: string,
): Array<{ code: boolean; bold: boolean; content: string }> {
  const parts: Array<{ code: boolean; bold: boolean; content: string }> = [];
  // Match **bold**, `code`, or plain runs
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ code: false, bold: false, content: text.slice(last, m.index) });
    }
    const tok = m[0]!;
    if (tok.startsWith("`")) {
      parts.push({ code: true, bold: false, content: tok.slice(1, -1) });
    } else if (tok.startsWith("**")) {
      parts.push({ code: false, bold: true, content: tok.slice(2, -2) });
    } else {
      parts.push({ code: false, bold: false, content: tok.slice(1, -1) });
    }
    last = m.index + tok.length;
  }

  if (last < text.length) {
    parts.push({ code: false, bold: false, content: text.slice(last) });
  }

  return parts;
}

function InlineText({ text }: { text: string }) {
  const parts = parseInline(text);
  if (parts.length === 1 && !parts[0]!.code && !parts[0]!.bold) {
    return <Text wrap="wrap">{text}</Text>;
  }
  return (
    <Text wrap="wrap">
      {parts.map((p, i) =>
        p.code ? (
          <Text key={i} color="cyan">
            {p.content}
          </Text>
        ) : p.bold ? (
          <Text key={i} bold>
            {p.content}
          </Text>
        ) : (
          <Text key={i}>{p.content}</Text>
        ),
      )}
    </Text>
  );
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

// ── Block renderer ─────────────────────────────────────────────────────────

function RenderBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const color =
        block.level === 1 ? "cyan" : block.level === 2 ? "white" : "white";
      const prefix = block.level === 1 ? "" : block.level === 2 ? "  " : "    ";
      return (
        <Box marginTop={block.level === 1 ? 1 : 0}>
          <Text bold color={color}>
            {prefix}
            {block.text}
          </Text>
        </Box>
      );
    }

    case "code":
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginY={0}
        >
          {block.lang && (
            <Text dimColor>{block.lang}</Text>
          )}
          <Text color="green">{block.text}</Text>
        </Box>
      );

    case "rule":
      return (
        <Box marginY={0}>
          <Text dimColor>{"─".repeat(50)}</Text>
        </Box>
      );

    case "list_item":
      return (
        <Box>
          <Text color="cyan">  • </Text>
          <InlineText text={block.text} />
        </Box>
      );

    case "table": {
      // Calculate column widths
      const colWidths = block.headers.map((h, ci) =>
        Math.max(h.length, ...block.rows.map((r) => (r[ci] ?? "").length)),
      );
      return (
        <Box flexDirection="column" marginY={0}>
          {/* Header row */}
          <Box>
            {block.headers.map((h, ci) => (
              <Text key={ci} bold color="cyan">
                {pad(h, colWidths[ci]!)}{"  "}
              </Text>
            ))}
          </Box>
          {/* Divider */}
          <Box>
            <Text dimColor>
              {colWidths.map((w) => "─".repeat(w)).join("  ")}
            </Text>
          </Box>
          {/* Data rows */}
          {block.rows.map((row, ri) => (
            <Box key={ri}>
              {block.headers.map((_, ci) => (
                <Text key={ci}>{pad(row[ci] ?? "", colWidths[ci]!)}{"  "}</Text>
              ))}
            </Box>
          ))}
        </Box>
      );
    }

    case "blank":
      return <Box marginY={0} />;

    case "paragraph":
      return <InlineText text={block.text} />;
  }
}
