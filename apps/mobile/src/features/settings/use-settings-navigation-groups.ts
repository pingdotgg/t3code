import { useAuth, useUser } from "@clerk/expo";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { Platform } from "react-native";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { buildSettingsNavigationGroups } from "./settings-sections";

type SettingsAccount = Parameters<typeof buildSettingsNavigationGroups>[0]["account"];

/** Reads Clerk, so call it only when T3 Connect is configured. */
export function useSettingsAccount(): NonNullable<SettingsAccount> {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  return {
    loading: !isLoaded,
    label: !isLoaded
      ? "Checking"
      : !isSignedIn
        ? "Sign in"
        : (user?.primaryEmailAddress?.emailAddress ?? "Signed in"),
  };
}

export function useSettingsNavigationGroups(account: SettingsAccount) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    selectedProjectKey === null
      ? null
      : scopedProjectMembers.length > 0
        ? deriveProjectGroupLabel({
            representative: scopedProjectMembers[0]!,
            members: scopedProjectMembers,
          })
        : (selectedProject?.label ?? "Unavailable project");
  return buildSettingsNavigationGroups({
    account,
    environmentCount: Object.keys(savedConnectionsById).length,
    deviceInputSettings: Platform.OS === "ios",
    projectLabel,
    serverSettingsAvailable: selectedTargets.length > 0,
  });
}
