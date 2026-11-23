const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "cursoragent@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
]);

const GENERATED_BY_AGENT =
  /^(?:🤖\s*)?generated (?:with|by)\s+(?:claude(?: code)?|codex|cursor|github copilot|copilot|opencode|grok|antigravity)[.!]?$/i;

const CO_AUTHOR_PREFIX = /^co-authored-by:/i;

function isAgentAuthor(text: string): boolean {
  const prefix = CO_AUTHOR_PREFIX.exec(text);
  if (prefix === null || !text.endsWith(">")) return false;
  const emailStart = text.lastIndexOf("<");
  if (emailStart < prefix[0].length) return false;
  const email = text.slice(emailStart + 1, -1).toLowerCase();
  if (!AGENT_EMAILS.has(email)) return false;
  // GitHub's generic noreply address is also used by people; require Copilot's name.
  return (
    email !== "noreply@github.com" ||
    /^(?:github )?copilot$/i.test(text.slice(prefix[0].length, emailStart).trim())
  );
}

export function removeAgentCredits(message: string): string {
  let fence: string | undefined;
  let removed = false;
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/).filter((line) => {
    if (/^(?: {4}|\t)/.test(line)) return true;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (fence !== undefined) return true;
    const text = line.trim().replace(/^(?:[-*]\s+)/, "");
    if (!isAgentAuthor(text)) {
      const footer = text.replace(
        /\[([^[\]\r\n]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s)[\]]*)?\)/gi,
        "$1",
      );
      if (!GENERATED_BY_AGENT.test(footer)) return true;
    }
    removed = true;
    return false;
  });
  if (!removed) return message;
  while (lines.length > 1 && /^[ \t]*$/.test(lines.at(-1)!)) {
    lines.pop();
  }
  return lines.join(newline);
}
