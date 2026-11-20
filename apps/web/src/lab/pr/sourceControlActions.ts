// Mockup stub: preparing a PR thread is allowed and does nothing.
export * from "~/state/sourceControlActions";
export const usePreparePullRequestThreadAction = (() => ({
  isAllowed: true,
  run: () => undefined,
  error: null,
})) as never;
