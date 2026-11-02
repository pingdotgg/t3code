import { useAtomValue } from "@effect/atom-react";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  pullRequestRoutingConnectionKey,
  pullRequestRoutingPermissionFor,
  type PullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";

import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const optionKeys: ReadonlyArray<{ value: PullRequestRoutingPermission; label: MessageKey }> = [
  { value: "off", label: "settings.code.prRouting.off" },
  { value: "read", label: "settings.code.prRouting.read" },
  { value: "read-write", label: "settings.code.prRouting.readWrite" },
];

const summaryLabels = {
  "read-write": "settings.code.prRouting.summaryReadWrite",
  read: "settings.code.prRouting.summaryRead",
} as const satisfies Record<string, MessageKey>;

function summarizePullRequestRouting(
  t: ReturnType<typeof useT>,
  entries: ReadonlyArray<{
    readonly label: string;
    readonly permission: PullRequestRoutingPermission;
  }>,
): string | null {
  const groups = (["read-write", "read"] as const).flatMap((permission) => {
    const labels = entries.filter((entry) => entry.permission === permission);
    return labels.length === 0
      ? []
      : [
          t("settings.code.prRouting.summaryGroup", {
            names: labels.map((entry) => entry.label).join(", "),
            permission: t(summaryLabels[permission]),
          }),
        ];
  });
  return groups.length === 0 ? null : groups.join(" · ");
}

export function PullRequestRoutingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const t = useT();
  const options = optionKeys.map(({ value, label }) => ({ value, label: t(label) }));
  const permissions = useAtomValue(environmentCatalog.pullRequestRoutingPermissionsValueAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const update = useAtomCommand(environmentCatalog.setPullRequestRoutingPermission);
  const [saving, setSaving] = useState(false);

  if (environments.length < 2) return null;

  const { id } = searchableSetting("pull-request-routing");
  return (
    <FoldedSettingsSection
      id={id}
      title={t("settings.code.prRouting.title")}
      summary={
        summarizePullRequestRouting(
          t,
          environments.map((environment) => ({
            label: environment.label,
            permission: pullRequestRoutingPermissionFor(environment.entry, permissions),
          })),
        ) ?? t("settings.code.prRouting.off")
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        {t("settings.code.prRouting.description")}
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={<EnvironmentTransportLabel environment={environment} />}
        >
          <Select
            items={options}
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
                      title: t("settings.code.prRouting.saveFailed"),
                    });
                },
              );
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-32"
              aria-label={t("settings.code.prRouting.aria", { name: environment.label })}
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
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}
