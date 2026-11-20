import { useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  pullRequestRoutingConnectionKey,
  pullRequestRoutingPermissionFor,
  type PullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsNote } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const options: ReadonlyArray<{ value: PullRequestRoutingPermission; label: string }> = [
  { value: "off", label: msg("Off", { $context: "pull request routing permission" }) },
  { value: "read", label: msg("Read PRs") },
  { value: "read-write", label: msg("Read and act") },
];

const summaryLabels = {
  "read-write": msg("{machines} read and act"),
  read: msg("{machines} read PRs"),
} as const;

function summarizePullRequestRouting(
  entries: ReadonlyArray<{
    readonly label: string;
    readonly permission: PullRequestRoutingPermission;
  }>,
  resolve: MessageResolver,
) {
  const groups = (["read-write", "read"] as const).flatMap((permission) => {
    const labels = entries.filter((entry) => entry.permission === permission);
    return labels.length === 0
      ? []
      : [
          resolve(summaryLabels[permission], {
            machines: labels.map((entry) => entry.label).join(", "),
          }),
        ];
  });
  return groups.length === 0 ? null : (
    <span className="grid gap-1">
      {groups.map((group) => (
        <span key={group}>{group}</span>
      ))}
    </span>
  );
}

export function PullRequestRoutingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const permissions = useAtomValue(environmentCatalog.pullRequestRoutingPermissionsValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const update = useAtomCommand(environmentCatalog.setPullRequestRoutingPermission);
  const [saving, setSaving] = useState(false);
  const gt = useGT();
  const m = useMessages();
  const items = options.map((option) => ({ ...option, label: m(option.label) }));

  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("pull-request-routing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        summarizePullRequestRouting(
          environments.map((environment) => ({
            label: environment.label,
            permission: pullRequestRoutingPermissionFor(environment.entry, permissions),
          })),
          m,
        ) ?? gt("Off", { $context: "pull request routing permission" })
      }
    >
      <SettingsNote>
        <T>
          Machines you trust here can read PR data through each other's source control access.
          Enable both machines. Read and act may use broader permissions than the machine that owns
          them. This applies only to this device.
        </T>
      </SettingsNote>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={<EnvironmentTransportLabel environment={environment} />}
        >
          <Select
            items={items}
            value={pullRequestRoutingPermissionFor(environment.entry, permissions)}
            disabled={
              !catalog.isReady ||
              saving ||
              pullRequestRoutingConnectionKey(environment.entry) === null
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
                      title: gt("Could not save pull request routing permission"),
                    });
                },
              );
            }}
          >
            <SelectTrigger
              variant="well"
              size="compact"
              className="w-32"
              aria-label={gt("{environment} pull request routing", {
                environment: environment.label,
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {items.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
