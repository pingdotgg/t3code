/**
 * Jira's wiki markup and the Markdown the rest of T3 Code reads and writes. Covers headings, bold,
 * italic, inline code, code blocks, links, bullet and numbered lists, and block quotes; anything
 * else, such as `{panel}` macros and tables, passes through unchanged.
 */

const HOLD = "\u0000";

/**
 * Swaps matches for tokens that no later rule touches, and puts them back at the end. A held
 * match may contain tokens held before it, so a release expands those too.
 */
function stash() {
  const held: string[] = [];
  const release = (text: string): string =>
    text.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, index: string) =>
      release(held[Number(index)]!),
    );
  return { hold: (text: string) => `${HOLD}${held.push(text) - 1}${HOLD}`, release };
}

const URL_TEXT = /https?:\/\/[^\s\]|)>]+/g;
const BOLD_WIKI = /(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g;
const ITALIC_WIKI = /(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/g;
const ITALIC_MD = /(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g;
// A macro closes with its own name, so a `{noformat}` block may show `{code}`.
const BLOCK_WIKI = /(?<!\{)\{(code|noformat)(?::([^}]*))?\}\n?([\s\S]*?)\n?\{\1\}/g;

/** Backticks one longer than the longest run in `text`, so `text` cannot close them. */
const ticksAround = (text: string, least: number) =>
  "`".repeat(Math.max(least, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)));

/** `{code:java|title=A.java}` and `{code:title=A.java|language=java}` both name Java. */
function codeLanguage(parameters: string | undefined): string {
  const parts = (parameters ?? "").split("|").map((part) => part.trim());
  const named = parts.find((part) => part.startsWith("language="));
  if (named !== undefined) return named.slice("language=".length);
  return parts[0] === undefined || parts[0].includes("=") ? "" : parts[0];
}

/** Whether a code block names more than its language, such as a title, which Markdown drops. */
export function hasUnwritableWiki(wiki: string): boolean {
  return [...wiki.matchAll(BLOCK_WIKI)].some(([, macro, parameters]) =>
    (parameters ?? "")
      .split("|")
      .map((part) => part.trim())
      .some(
        (part, index) =>
          part.length > 0 &&
          (macro === "noformat" ||
            !(part.startsWith("language=") || (index === 0 && !part.includes("=")))),
      ),
  );
}

export function wikiToMarkdown(wiki: string): string {
  const { hold, release } = stash();
  // A literal NUL would read as a token, so none survives into the text.
  let text = wiki.replaceAll("\r\n", "\n").replaceAll(HOLD, "");
  text = text.replace(
    BLOCK_WIKI,
    (_, macro: string, parameters: string | undefined, code: string) => {
      const fence = ticksAround(code, 3);
      return hold(`${fence}${macro === "code" ? codeLanguage(parameters) : ""}\n${code}\n${fence}`);
    },
  );
  text = text.replace(/\{\{([^}\n]+)\}\}/g, (_, code: string) => {
    const ticks = ticksAround(code, 1);
    const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
    return hold(`${ticks}${pad}${code}${pad}${ticks}`);
  });
  text = text.replace(/\[([^\]|\n]+)\|(https?:\/\/[^\]\s]+|mailto:[^\]\s]+)\]/g, (_, label, url) =>
    hold(`[${label}](${url})`),
  );
  text = text.replace(/\[(https?:\/\/[^\]\s]+)\]/g, (_, url) => hold(`<${url}>`));
  text = text.replace(URL_TEXT, hold);
  return release(
    text
      .split("\n")
      .map((line) => {
        const heading = /^h([1-6])\.\s+(.*)$/.exec(line);
        if (heading !== null)
          return `${"#".repeat(Number(heading[1]))} ${inlineWikiToMarkdown(heading[2]!)}`;
        const item = /^([*#]+)\s+(.*)$/.exec(line);
        if (item !== null) {
          const [, markers, content] = item;
          const marker = markers!.endsWith("#") ? "1." : "-";
          return `${"   ".repeat(markers!.length - 1)}${marker} ${inlineWikiToMarkdown(content!)}`;
        }
        const quote = /^bq\.\s+(.*)$/.exec(line);
        if (quote !== null) return `> ${inlineWikiToMarkdown(quote[1]!)}`;
        return inlineWikiToMarkdown(line);
      })
      .join("\n"),
  );
}

function inlineWikiToMarkdown(text: string): string {
  return text.replace(BOLD_WIKI, "$1**$2**").replace(ITALIC_WIKI, "$1*$2*");
}

export function markdownToWiki(markdown: string): string {
  const { hold, release } = stash();
  let text = markdown.replaceAll("\r\n", "\n").replaceAll(HOLD, "");
  text = holdFences(text, hold);
  // A code span closes on a run of backticks as long as its opener; one space each side is padding.
  text = text.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (_, _ticks, code: string) =>
    hold(`{{${/^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code}}}`),
  );
  text = text.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label, url) =>
    hold(`[${label}|${url}]`),
  );
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => hold(`[${url}]`));
  text = text.replace(URL_TEXT, hold);
  const levels: Array<{ indent: number; marker: string }> = [];
  const nest = (indent: number, marker: string) => {
    while (levels.length > 0 && levels.at(-1)!.indent > indent) levels.pop();
    if (levels.length === 0 || levels.at(-1)!.indent < indent) levels.push({ indent, marker });
    else levels[levels.length - 1] = { indent, marker };
    return levels.map((level) => level.marker).join("");
  };
  return release(
    text
      .split("\n")
      .map((line) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const item = /^([ \t]*)(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
        const quote = /^>\s?(.*)$/.exec(line);
        if (item === null && line.trim() !== "") levels.length = 0;
        if (heading !== null) return `h${heading[1]!.length}. ${inlineMarkdownToWiki(heading[2]!)}`;
        if (item !== null) {
          const indent = item[1]!.replaceAll("\t", "  ").length;
          return `${nest(indent, item[2] === undefined ? "#" : "*")} ${inlineMarkdownToWiki(item[3]!)}`;
        }
        if (quote !== null) return `bq. ${inlineMarkdownToWiki(quote[1]!)}`;
        return inlineMarkdownToWiki(line);
      })
      .join("\n"),
  );
}

/**
 * Swaps each fenced block for a held `{code}` macro. A fence opens with three or more backticks or
 * tildes and closes only on a run of the same character at least as long; an open one runs to the
 * end. A fence indented under a list item loses that indent, which Jira's lists cannot carry.
 */
function holdFences(text: string, hold: (text: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(lines[index]!);
    if (open === null || (open[2]![0] === "`" && open[3]!.includes("`"))) {
      out.push(lines[index]!);
      continue;
    }
    const [, indent, fence, info] = open;
    const closer = new RegExp(`^[ \\t]*${fence![0]}{${fence!.length},}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !closer.test(lines[end]!)) end += 1;
    const code = lines
      .slice(index + 1, end)
      .map((line) => line.replace(new RegExp(`^[ \\t]{0,${indent!.length}}`), ""))
      .join("\n");
    const language = info!.trim().split(/\s+/)[0] ?? "";
    out.push(hold(`{code${language === "" ? "" : `:${language}`}}\n${code}\n{code}`));
    index = end;
  }
  return out.join("\n");
}

/** Bold becomes a private marker first, so the single stars left are the italics. */
function inlineMarkdownToWiki(text: string): string {
  return text
    .replace(
      /\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g,
      (_, star, underscore) => `\u0001${star ?? underscore}\u0001`,
    )
    .replace(ITALIC_MD, "$1_$2_")
    .replaceAll("\u0001", "*");
}
