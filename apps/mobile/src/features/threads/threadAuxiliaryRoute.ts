export type ThreadAuxiliaryRoute = "browser" | "files";

export type ThreadAuxiliaryRouteAction = "close" | "navigate" | "replace" | "show-inspector";

export function resolveThreadAuxiliaryRouteAction(input: {
  readonly current: ThreadAuxiliaryRoute | null;
  readonly target: ThreadAuxiliaryRoute;
  readonly persistentFileInspector: boolean;
}): ThreadAuxiliaryRouteAction {
  if (input.current === input.target) {
    return "close";
  }
  if (input.current !== null) {
    return "replace";
  }
  if (input.target === "files" && input.persistentFileInspector) {
    return "show-inspector";
  }
  return "navigate";
}
