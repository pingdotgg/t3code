import { useState } from "react";

import type { MessageKey } from "@t3tools/client-runtime/i18n";
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

const FAILURE_TITLES = {
  install: "settings.providers.cli.installError",
  uninstall: "settings.providers.cli.removeError",
  addToPath: "settings.providers.cli.addToPathError",
} as const satisfies Record<string, MessageKey>;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const t = useT();
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t(FAILURE_TITLES[action]),
            description:
              error instanceof Error ? error.message : t("settings.providers.cli.genericError"),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const t = useT();
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("settings.providers.cli.shadowed", { path: state.shadowedBy })
    : !installed
      ? t("settings.providers.cli.notInstalled")
      : state.onPath
        ? t("settings.providers.cli.installedOnPath", { path: state.installedPath ?? "" })
        : state.pathSetup?.added
          ? t("settings.providers.cli.installedAddedToPath", {
              path: state.installedPath ?? "",
              file: state.pathSetup.file,
            })
          : `${t("settings.providers.cli.installedNotOnPath", { path: state.installedPath ?? "" })}${
              state.pathSetup ? "" : t("settings.providers.cli.addFolderToPath")
            }`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      title={t("settings.providers.cli.title")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              {t("settings.providers.cli.addToPath")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? t("settings.providers.cli.remove") : t("settings.providers.cli.install")}
          </Button>
        </div>
      }
    />
  );
}
