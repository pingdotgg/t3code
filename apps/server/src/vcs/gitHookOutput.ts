// Git's own lines stay out: they are classified into a reason and can name private refs or paths.
const GIT_OWN_LINE = /^(?:fatal|error|warning|hint):|^Preparing worktree |^Updating files:/;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const MAX_LINES = 20;
const MAX_CHARS = 1_000;

/** Appends what a hook or filter printed, which often names the fix for a failed checkout. */
export function withHookOutput(detail: string, stderr: string): string {
  const lines = stderr
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !GIT_OWN_LINE.test(line))
    .slice(-MAX_LINES);
  if (lines.length === 0) return detail;
  const output = lines.join("\n").replace(URL_USERINFO, "$1<redacted>@");
  return `${detail}: ${output.length > MAX_CHARS ? `…${output.slice(-MAX_CHARS)}` : output}`;
}
