import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type MobileGitStatusSurface =
  | "thread-route"
  | "git-overview"
  | "review"
  | "confirm"
  | "branches"
  | "commit";

export interface MobileGitStatusTargetInput {
  readonly active: boolean;
  readonly focused: boolean;
  readonly platform: string;
  readonly route: {
    readonly environmentId: string;
    readonly threadId: string;
  };
  readonly selected: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly cwd: string | null;
  } | null;
  readonly surface: MobileGitStatusSurface;
}

export interface MobileGitStatusTarget {
  readonly demand: "local" | "remote";
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}

export function resolveMobileGitStatusTarget(
  input: MobileGitStatusTargetInput,
): MobileGitStatusTarget | null {
  if (!input.active || !input.focused || input.selected === null || input.selected.cwd === null) {
    return null;
  }
  if (
    String(input.selected.environmentId) !== input.route.environmentId ||
    String(input.selected.threadId) !== input.route.threadId
  ) {
    return null;
  }
  if (
    input.platform === "android" &&
    (input.surface === "thread-route" || input.surface === "review")
  ) {
    return null;
  }

  return {
    demand: input.surface === "branches" || input.surface === "commit" ? "local" : "remote",
    environmentId: input.selected.environmentId,
    input: { cwd: input.selected.cwd },
  };
}

export function isMobileGitInspectorActive(input: {
  readonly mode: "files" | "git" | "route";
  readonly paneVisible: boolean;
  readonly registrationActive?: boolean;
}): boolean {
  return (input.registrationActive ?? true) && input.paneVisible && input.mode === "git";
}
