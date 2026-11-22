// Mockup stub: the fixture PR is not part of a stack.
export * from "~/state/usePullRequestStack";
export const usePullRequestStack = (() => ({
  data: null,
  isFresh: true,
  isPending: false,
  error: null,
  notice: null,
  refresh: () => undefined,
})) as never;
