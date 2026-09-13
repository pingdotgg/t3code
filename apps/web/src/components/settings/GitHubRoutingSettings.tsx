import { useAtomValue } from "@effect/atom-react";
import {
  gitHubRoutingConnectionKey,
  gitHubRoutingPermissionFor,
  type GitHubRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const options: ReadonlyArray<{ value: GitHubRoutingPermission; label: string }> = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read PRs" },
  { value: "read-write", label: "Read and act" },
];

export function GitHubRoutingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const permissions = useAtomValue(environmentCatalog.githubRoutingPermissionsValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const update = useAtomCommand(environmentCatalog.setGitHubRoutingPermission);
  const [saving, setSaving] = useState(false);

  return (
    <SettingsSection {...searchableSetting("github-routing")}>
      <SettingsRow
        title="Share GitHub access"
        description="Choose environments you trust to share PR data and use each other's GitHub access. Enable both environments. Read and act may use broader permissions than the original environment. This applies only to this client."
      />
      {environments.map((environment) => (
        <SettingsRow
          key={environment.environmentId}
          title={environment.label}
          description={environment.displayUrl ?? "T3 Connect"}
          control={
            <Select
              items={options}
              value={gitHubRoutingPermissionFor(environment.entry, permissions)}
              disabled={
                !catalog.isReady || saving || gitHubRoutingConnectionKey(environment.entry) === null
              }
              onValueChange={(permission) => {
                if (permission === null) return;
                setSaving(true);
                void update({ environmentId: environment.environmentId, permission }).then(
                  (result) => {
                    setSaving(false);
                    if (result._tag === "Failure")
                      toastManager.add({
                        type: "error",
                        title: "Could not save GitHub routing permission",
                      });
                  },
                );
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={`${environment.label} GitHub routing`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {options.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ))}
    </SettingsSection>
  );
}
