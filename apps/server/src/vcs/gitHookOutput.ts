// Git's own lines stay out: they are classified into a reason and can name private refs or paths.
const GIT_OWN_LINE = /^(?:fatal|error|warning|hint):|^Preparing worktree |^Updating files:/;
// Userinfo runs through the authority's last `@`; query strings can carry tokens or signatures.
// Quotes and brackets end a URL, so adjacent ones redact separately. A bounded scheme keeps it linear.
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#"'<>]*@)?([^\s?#"'<>]*)(\?[^\s#"'<>]*)?/gi;
const MAX_LINES = 20;
const MAX_CHARS = 1_000;

const redactUrls = (text: string) =>
  text.replace(
    URL_PATTERN,
    (_, scheme: string, userinfo?: string, rest?: string, query?: string) =>
      `${scheme}${userinfo ? "<redacted>@" : ""}${rest ?? ""}${query ? "?<redacted>" : ""}`,
  );

/** Appends what a hook or filter printed, which often names the fix for a failed checkout. */
export function withHookOutput(detail: string, stderr: string): string {
  const lines = stderr
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !GIT_OWN_LINE.test(line))
    .slice(-MAX_LINES);
  if (lines.length === 0) return detail;
  const output = redactUrls(lines.join("\n"));
  return `${detail}: ${output.length > MAX_CHARS ? `…${output.slice(-MAX_CHARS)}` : output}`;
}
