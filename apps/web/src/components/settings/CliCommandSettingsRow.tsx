import { useState } from "react";

import { useT } from "../../hooks/useI18n";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CliCommandSettingsRow() {
  const t = useT();
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const state = query.data;
  const [pending, setPending] = useState(false);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              action === "install"
                ? t("settings.providers.cli.installError")
                : t("settings.providers.cli.removeError"),
            description:
              error instanceof Error ? error.message : t("settings.providers.cli.genericError"),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("settings.providers.cli.shadowed", { path: state.shadowedBy })
    : !installed
      ? t("settings.providers.cli.notInstalled")
      : state.onPath
        ? t("settings.providers.cli.installedOnPath", { path: state.installedPath ?? "" })
        : t("settings.providers.cli.installedNotOnPath", { path: state.installedPath ?? "" });

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      title={t("settings.providers.cli.title")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending || query.isPending || (!installed && Boolean(state.shadowedBy))}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? t("settings.providers.cli.remove") : t("settings.providers.cli.install")}
        </Button>
      }
    />
  );
}
