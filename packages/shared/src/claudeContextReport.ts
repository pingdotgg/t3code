import type { ContextCategory, ContextReport, ContextSection } from "./contextReport.ts";

export function parseClaudeContextTokens(text: string): number | null {
  const match = /^[~<>\s]*([\d,]+(?:\.\d+)?)\s*([km])?$/iu.exec(text.trim());
  if (!match || match[1] === undefined) return null;
  const value = Number(match[1].replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  return Math.round(value * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1));
}

function splitRow(line: string): ReadonlyArray<string> | null {
  if (!line.startsWith("|") || !line.endsWith("|") || line.includes("\\|")) return null;
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function parseTable(lines: ReadonlyArray<string>): Pick<ContextSection, "columns" | "rows"> | null {
  const [headerLine, separatorLine, ...rowLines] = lines;
  const columns = headerLine === undefined ? null : splitRow(headerLine);
  const separator = separatorLine === undefined ? null : splitRow(separatorLine);
  if (
    !columns ||
    !separator ||
    separator.length !== columns.length ||
    !separator.every((cell) => /^:?-+:?$/u.test(cell))
  ) {
    return null;
  }
  const rows: Array<ReadonlyArray<string>> = [];
  for (const line of rowLines) {
    const cells = splitRow(line);
    if (!cells || cells.length !== columns.length) return null;
    rows.push(cells);
  }
  return { columns, rows };
}

function parseCategories(
  table: Pick<ContextSection, "columns" | "rows">,
): ReadonlyArray<ContextCategory> | null {
  if (table.columns.length !== 3) return null;
  const categories: ContextCategory[] = [];
  for (const [name = "", tokens = "", percentText = ""] of table.rows) {
    const percentMatch = /^(\d+(?:\.\d+)?)%$/u.exec(percentText);
    if (!percentMatch?.[1] || parseClaudeContextTokens(tokens) === null) return null;
    categories.push({ name, tokens, percent: Number(percentMatch[1]) });
  }
  return categories;
}

function sectionTotalTokens(table: Pick<ContextSection, "columns" | "rows">): number | null {
  const tokenColumn = table.columns.findIndex((column) => /^tokens$/iu.test(column));
  if (tokenColumn === -1) return null;
  let total = 0;
  for (const row of table.rows) {
    const tokens = parseClaudeContextTokens(row[tokenColumn] ?? "");
    if (tokens === null) return null;
    total += tokens;
  }
  return total;
}

export function parseClaudeContextReport(text: string): ContextReport | null {
  if (!text.trimStart().startsWith("## Context Usage")) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.shift() !== "## Context Usage") return null;

  let model: string | null = null;
  let tokens: RegExpExecArray | null = null;
  let overLimit: string | null = null;
  while (lines.length > 0 && !lines[0]!.startsWith("### ")) {
    const line = lines.shift()!;
    const modelMatch = /^\*\*Model:\*\*\s*(.+)$/u.exec(line);
    const tokensMatch = /^\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)\s*\((\d+(?:\.\d+)?)%\)$/u.exec(line);
    const overLimitMatch = /^\*\*Over limit:\*\*\s*(.+)$/u.exec(line);
    if (modelMatch?.[1] && model === null) model = modelMatch[1];
    else if (tokensMatch && tokens === null) tokens = tokensMatch;
    else if (overLimitMatch?.[1] && overLimit === null) overLimit = overLimitMatch[1];
    else return null;
  }
  if (!tokens?.[1] || !tokens[2] || !tokens[3]) return null;
  if (
    parseClaudeContextTokens(tokens[1]) === null ||
    (parseClaudeContextTokens(tokens[2]) ?? 0) <= 0
  ) {
    return null;
  }

  let categories: ReadonlyArray<ContextCategory> | null = null;
  const sections: ContextSection[] = [];
  while (lines.length > 0) {
    const title = lines.shift()!.slice("### ".length).trim();
    const end = lines.findIndex((line) => line.startsWith("### "));
    const table = parseTable(end === -1 ? lines.splice(0) : lines.splice(0, end));
    if (!table || title.length === 0) return null;
    if (title === "Estimated usage by category") {
      if (categories !== null) return null;
      categories = parseCategories(table);
      if (categories === null) return null;
      continue;
    }
    sections.push({ title, ...table, totalTokens: sectionTotalTokens(table) });
  }

  return {
    model,
    usedTokens: tokens[1],
    maxTokens: tokens[2],
    usedPercent: Number(tokens[3]),
    overLimit,
    categories: categories ?? [],
    sections,
  };
}
