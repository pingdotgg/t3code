import type { EnvironmentId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";

export interface SettingsScopeSearch {
  scope?: "device" | "all" | undefined;
  project?: string | undefined;
  machine?: string | undefined;
  checkout?: string | undefined;
}

type ScopeTargets = {
  label: string;
  members: readonly SidebarProjectGroupMember[];
  environmentIds: readonly EnvironmentId[];
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "device" | "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | {
        kind: "project";
        group: SidebarProjectSnapshot;
        environmentId: EnvironmentId | null;
      }
    | {
        kind: "checkout";
        group: SidebarProjectSnapshot;
        checkout: SidebarProjectGroupMember;
        environmentId: EnvironmentId;
      }
    | {
        kind: "unavailable";
        reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing";
        message: string;
      }
  );

/** Explicit broad targets replace narrower selections; stale IDs remain visible to the resolver. */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  if (raw.scope === "device" || raw.scope === "all") return { scope: raw.scope };
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const project = stringValue(raw.project);
  const machine = stringValue(raw.machine);
  const checkout = stringValue(raw.checkout);
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
    ...(checkout === undefined ? {} : { checkout }),
  };
}

/** Resolves only existing targets. An unavailable selection never broadens a subsequent write. */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[],
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
  });

  if (search.scope === "device") {
    return { kind: "device", label: "This device", members: [], environmentIds: [] };
  }
  if (search.scope === "all") {
    return {
      kind: "all",
      label: "All environments",
      members: [],
      environmentIds: environments.map((environment) => environment.environmentId),
    };
  }
  if (search.checkout && !search.project) {
    return unavailable("project-required", "Select a project to choose one of its checkouts.");
  }

  const environment = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !environment) {
    return unavailable("environment-missing", "This environment is no longer available.");
  }

  if (search.project) {
    const group = groups.find((candidate) => candidate.projectKey === search.project);
    if (!group) return unavailable("project-missing", "This project is no longer available.");
    const members = group.memberProjects.filter(
      (member) =>
        (search.machine === undefined || member.environmentId === search.machine) &&
        (search.checkout === undefined || member.physicalProjectKey === search.checkout),
    );
    if (members.length === 0) {
      return unavailable(
        "checkout-missing",
        search.checkout
          ? "This checkout is no longer available in the selected project and environment."
          : "This project has no checkout on this environment.",
      );
    }
    if (search.checkout) {
      const checkout = members[0]!;
      const checkoutEnvironment = environments.find(
        (candidate) => candidate.environmentId === checkout.environmentId,
      );
      if (!checkoutEnvironment) {
        return unavailable(
          "environment-missing",
          "This checkout's environment is no longer available.",
        );
      }
      const sharesEnvironment = group.memberProjects.some(
        (member) =>
          member.environmentId === checkout.environmentId &&
          member.physicalProjectKey !== checkout.physicalProjectKey,
      );
      return {
        kind: "checkout",
        group,
        checkout,
        environmentId: checkout.environmentId,
        label: `${group.displayName} / ${checkoutEnvironment.label}${sharesEnvironment ? ` · ${checkout.workspaceRoot}` : ""}`,
        members,
        environmentIds: [checkout.environmentId],
      };
    }
    return {
      kind: "project",
      group,
      environmentId: environment?.environmentId ?? null,
      label: `${group.displayName} / ${environment?.label ?? "All checkouts"}`,
      members,
      environmentIds: [...new Set(members.map((member) => member.environmentId))],
    };
  }
  if (environment) {
    return {
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      members: [],
      environmentIds: [environment.environmentId],
    };
  }
  return {
    kind: "all",
    label: "All environments",
    members: [],
    environmentIds: environments.map((candidate) => candidate.environmentId),
  };
}
