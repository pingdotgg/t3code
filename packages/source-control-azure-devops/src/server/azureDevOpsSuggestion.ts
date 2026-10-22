import { pullRequestSuggestion } from "@t3tools/shared/pullRequestSuggestion";

export function applyAzureDevOpsSuggestion(input: {
  body: string;
  content: string;
  startLine: number;
  endLine: number;
}) {
  const suggestion = pullRequestSuggestion(input.body);
  if (suggestion === null) throw new Error("Choose a comment containing exactly one suggestion.");
  // Odd entries are each line's own ending, so every line outside the range keeps its own.
  const parts = input.content.split(/(\r?\n)/);
  const lastLine = (parts.length + 1) / 2 - (parts.at(-1) === "" ? 1 : 0);
  if (input.startLine < 1 || input.endLine < input.startLine || input.endLine > lastLine)
    throw new Error("The suggestion no longer matches a valid line range.");
  const before = parts.slice(0, 2 * input.startLine - 2).join("");
  // An empty suggestion deletes the lines together with their endings.
  if (suggestion === "") return before + parts.slice(2 * input.endLine).join("");
  const newline = parts[2 * input.startLine - 1] ?? parts[2 * input.startLine - 3] ?? "\n";
  return (
    before +
    suggestion
      .replace(/\r?\n$/, "")
      .split(/\r?\n/)
      .join(newline) +
    parts.slice(2 * input.endLine - 1).join("")
  );
}
