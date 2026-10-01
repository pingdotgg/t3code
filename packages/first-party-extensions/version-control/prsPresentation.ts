export const muted = "var(--t3-version-control-muted-foreground, var(--muted-foreground, #667085))";
export const border = "1px solid var(--t3-version-control-border, var(--border, #dfe3e8))";

const operationPrefix = /^Pull request operation \w+ failed:\s*/iu;
const toolNoise = [
  /^(github|gitlab|bitbucket|azure devops)?\s*(cli|api)?\s*(command\s*)?failed\.?$/iu,
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
];

export function prsReadableFailure(failure: unknown, hint: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.replace(operationPrefix, "").trim();
  if (detail.length === 0 || toolNoise.some((pattern) => pattern.test(detail))) return hint;
  return detail.length <= 320 ? detail : `${detail.slice(0, 319)}…`;
}
