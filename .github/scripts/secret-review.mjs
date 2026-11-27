import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const owner = "@neur0map";
const marker = "<!-- hyakki-secret-review -->";
const gh = (...args) => NodeChildProcess.execFileSync("gh", args, { encoding: "utf8" });

export function protectedPaths(codeowners) {
  return codeowners.split(/\r?\n/).flatMap((line) => {
    const [pattern, actor] = line.trim().split(/\s+/);
    if (!pattern || actor !== owner) return [];
    const rooted = pattern.startsWith("/");
    const text = pattern.replace(/^\//, "").replace(/\/$/, "");
    const expression = text
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**/", "\0")
      .replaceAll("*", "[^/]*")
      .replaceAll("\0", "(?:.*/)?");
    return [
      new RegExp(
        `${rooted ? "^" : "(?:^|/)"}${expression}${pattern.endsWith("/") ? "/" : "(?:$|/)"}`,
      ),
    ];
  });
}

export function touchesSecrets(files, rules) {
  return files.some((file) =>
    [file.filename, file.previous_filename].some(
      (name) => typeof name === "string" && rules.some((rule) => rule.test(name)),
    ),
  );
}

function notify() {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: number, CHANGED_FILES: count } = process.env;
  if (!repo || !number || !/^\d+$/.test(number) || !count || !/^\d+$/.test(count)) {
    throw new Error("Missing pull request metadata.");
  }
  const rules = protectedPaths(NodeFS.readFileSync(".github/CODEOWNERS", "utf8"));
  const files = JSON.parse(
    gh("api", `repos/${repo}/pulls/${number}/files?per_page=100`, "--paginate", "--slurp"),
  ).flat();
  if (rules.length > 0 && files.length === Number(count) && !touchesSecrets(files, rules)) return;
  const thread = `repos/${repo}/issues/${number}/comments`;
  const comments = JSON.parse(gh("api", `${thread}?per_page=100`, "--paginate", "--slurp")).flat();
  if (
    comments.some(
      (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker),
    )
  )
    return;
  gh(
    "api",
    thread,
    "-f",
    `body=${marker}\n${owner}, this PR touches credential, sign-in, or review-policy code, or the full file list could not be checked. Please review it before merging.`,
  );
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) notify();
