export interface WorkflowRunLink {
  readonly env: string;
  readonly run: string;
}

/** Matches the app's own root-relative link to a run, as agents write it in chat. */
export function parseWorkflowRunHref(href: string | undefined): WorkflowRunLink | null {
  if (!href?.startsWith("/workflows?")) return null;
  const { searchParams } = new URL(href, "https://example.invalid");
  const env = searchParams.get("env");
  const run = searchParams.get("run");
  return env && run ? { env, run } : null;
}
