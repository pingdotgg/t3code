import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const dash = "\u2014";
const codeFile =
  /(?:\.(?:[cm]?[jt]sx?|css|scss|go|rs|c|cpp|h|hpp|java|kt|swift|qml|lua|py|sh|bash|zsh|fish|ps1|html|vue|svelte|rb|toml|ya?ml)|(?:^|\/)Dockerfile)$/i;
const slashCode = /\.(?:[cm]?[jt]sx?|css|scss|go|rs|c|cpp|h|hpp|java|kt|swift|qml|vue|svelte)$/i;
const hashCode = /(?:\.(?:py|sh|bash|zsh|fish|ps1|rb|toml|ya?ml)|(?:^|\/)Dockerfile)$/i;
const markup = /\.(?:html|vue|svelte)$/i;
const aiName =
  /\b(?:openai|anthropic|chatgpt|claude(?:\s+code)?|codex|copilot|gemini|cursor|oh[ -]my[ -]pi|omp|gpt(?:-[\w.]+)?|pi coding agent|opencode|aider|windsurf|devin)\b/i;
const credit =
  /(?:\b(?:authored|written|generated|assisted|created|built|modified|implemented|powered)\s+(?:by|with|using)\b|^\s*(?:ai|assistant|agent|harness)\s*:)/i;
const trailer = /^\s*(?:co-authored-by|generated-with|assisted-by|ai-assisted-by)\s*:/i;

const hasAttribution = (line) =>
  trailer.test(line) ||
  (credit.test(line) && (aiName.test(line) || /\b(?:pi|ai|assistant|agent|harness)\b/i.test(line)));

export function messageIssues(text) {
  const lines = text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#"));
  return [
    ...(lines.some((line) => line.includes(dash))
      ? ["Commit messages cannot contain em dashes."]
      : []),
    ...(lines.some(hasAttribution)
      ? ["Commit messages cannot contain authorship or AI attribution trailers."]
      : []),
  ];
}

export function commentCounts(path, text) {
  const slash = slashCode.test(path);
  const hash = hashCode.test(path) || /(?:^|\/)\.(?:vite-hooks|githooks)\//.test(path);
  const html = markup.test(path);
  const lua = path.endsWith(".lua");
  const lines = text.split(/\r?\n/);
  let end = "";
  let nonblank = 0;
  let comments = 0;
  for (const [index, source] of lines.entries()) {
    const line = source.trim();
    if (!line || (index === 0 && line.startsWith("#!"))) continue;
    nonblank += 1;
    let counted = Boolean(end);
    let quote = "";
    for (let i = 0; i < line.length; i += 1) {
      if (end) {
        const close = line.indexOf(end, i);
        if (close < 0) break;
        i = close + end.length - 1;
        end = "";
        continue;
      }
      const char = line[i];
      if (quote) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = "";
        continue;
      }
      const blocks = [
        [slash, "/*", "*/"],
        [html, "<!--", "-->"],
        [lua, "--[[", "]]"],
        [path.endsWith(".ps1"), "<#", "#>"],
      ];
      const block = blocks.find(([enabled, start]) => enabled && line.startsWith(start, i));
      if (block) {
        counted = true;
        end = block[2];
        i += block[1].length - 1;
      } else if (
        (slash && line.startsWith("//", i)) ||
        (lua && line.startsWith("--", i)) ||
        (hash && char === "#" && (i === 0 || /\s/.test(line[i - 1])))
      ) {
        counted = true;
        break;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      }
    }
    if (counted) comments += 1;
  }
  return { comments, nonblank };
}

const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });

function stagedIssues() {
  const issues = [];
  const diff = git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=0").toString();
  let path = "";
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (!inHunk && line.startsWith("+++ ")) path = line.slice(4);
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk || !line.startsWith("+")) continue;
    if (line.includes(dash)) issues.push(`${path}: remove the em dash from the added line.`);
    if (hasAttribution(line.slice(1))) issues.push(`${path}: remove the attribution.`);
  }
  for (const file of git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    .toString()
    .split("\0")) {
    if (!file || !(codeFile.test(file) || /^(?:\.vite-hooks|\.githooks)\//.test(file))) continue;
    const entry = git("ls-files", "-s", "--", file).toString();
    if (!/^100[67]/.test(entry)) continue;
    const bytes = git("show", `:${file}`);
    if (bytes.includes(0)) continue;
    const { comments, nonblank } = commentCounts(file, bytes.toString());
    if (comments * 10 > nonblank)
      issues.push(`${file}: ${comments}/${nonblank} nonblank lines are comments; maximum is 10%.`);
  }
  return [...new Set(issues)];
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  const issues =
    mode === "staged"
      ? stagedIssues()
      : mode === "message" && file
        ? messageIssues(NodeFS.readFileSync(file, "utf8"))
        : ["Usage: policy.mjs staged | message <file>"];
  for (const issue of issues) console.error(issue);
  if (issues.length) process.exitCode = 1;
}
