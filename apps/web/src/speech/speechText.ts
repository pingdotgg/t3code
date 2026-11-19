import type { SpeechSettings } from "@t3tools/contracts";

/** Fenced code in these languages is terminal output rather than code. */
const TERMINAL_LANGUAGES = new Set([
  "console",
  "terminal",
  "shell-session",
  "sh-session",
  "output",
  "log",
  "logs",
  "text",
  "txt",
  "stdout",
  "stderr",
  "",
]);

type SpeechTextOptions = Pick<
  SpeechSettings,
  "readCodeBlocks" | "readTerminalOutput" | "maxCharacters" | "pronunciations"
>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Markdown from an agent message as plain text worth hearing: code and terminal output are
 * summarized unless the user enabled them, markup is dropped, and custom pronunciations apply.
 */
export function speakableText(markdown: string, options: SpeechTextOptions): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(
    /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g,
    (_match, info: string, body: string) => {
      const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const terminal = TERMINAL_LANGUAGES.has(language) || /^\s*[$#>] /m.test(body);
      if (terminal) {
        return options.readTerminalOutput ? `\n${body}\n` : "\n(Terminal output omitted.)\n";
      }
      if (!options.readCodeBlocks) {
        return `\n(${language ? `${language} ` : ""}code block omitted.)\n`;
      }
      return `\n${body}\n`;
    },
  );
  text = text
    // Images, then links: keep the visible label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "link")
    .replace(/https?:\/\/\S+/g, "link")
    // Inline code keeps its text; it is usually a name worth hearing.
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "");
  for (const { from, to } of options.pronunciations) {
    if (from.trim() === "") continue;
    text = text.replace(new RegExp(`\\b${escapeRegExp(from.trim())}\\b`, "gi"), to);
  }
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .replace(/[ \t]{2,}/g, " ");
  if (text.length > options.maxCharacters) {
    const cut = text.slice(0, options.maxCharacters);
    const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"), cut.lastIndexOf("? "));
    text = `${cut.slice(0, boundary > options.maxCharacters * 0.5 ? boundary + 1 : cut.length).trim()} (Message shortened.)`;
  }
  return text;
}

/**
 * Splits text into utterances of at most `limit` characters at sentence boundaries. Chromium
 * stops long utterances partway, so speech always goes out in short pieces.
 */
export function speechChunks(text: string, limit = 220): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim() !== "") chunks.push(current.trim());
    current = "";
  };
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    if (sentence.length > limit) {
      flush();
      for (let start = 0; start < sentence.length; start += limit) {
        const piece = sentence.slice(start, start + limit);
        const space = start + limit < sentence.length ? piece.lastIndexOf(" ") : -1;
        if (space > limit * 0.5) {
          chunks.push(piece.slice(0, space).trim());
          start -= piece.length - space;
        } else {
          chunks.push(piece.trim());
        }
      }
      continue;
    }
    if (current.length + sentence.length + 1 > limit) flush();
    current = current === "" ? sentence : `${current} ${sentence}`;
  }
  flush();
  return chunks;
}

/**
 * For streaming speech: the part of `text` after `spokenLength` that ends at a sentence boundary,
 * so a sentence is only spoken once it is complete.
 */
export function completedSentencesSince(
  text: string,
  spokenLength: number,
): { readonly text: string; readonly end: number } | null {
  const rest = text.slice(spokenLength);
  const match = /[\s\S]*[.!?:\n](?=\s|$)/.exec(rest);
  if (!match || match[0].trim() === "") return null;
  let end = spokenLength + match[0].length;
  // Never stop inside an open code fence; its body would later be read as prose.
  const fences = text.slice(0, end).match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) {
    end = text.lastIndexOf("```", end);
    if (end <= spokenLength) return null;
  }
  const chunk = text.slice(spokenLength, end);
  return chunk.trim() === "" ? null : { text: chunk, end };
}
