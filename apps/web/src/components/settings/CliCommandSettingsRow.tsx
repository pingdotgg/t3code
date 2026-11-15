import { useTranslation } from "react-i18next";
import { useState } from "react";

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

const FAILURE_TITLE_KEYS = {
  install: "cliCommand.failureInstall",
  uninstall: "cliCommand.failureUninstall",
  addToPath: "cliCommand.failureAddToPath",
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const { t } = useTranslation("settings");
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLE_KEYS) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t(FAILURE_TITLE_KEYS[action]),
            description: error instanceof Error ? error.message : t("cliCommand.failureGeneric"),
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
  const { t } = useTranslation("settings");
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("cliCommand.shadowed", { path: state.shadowedBy })
    : !installed
      ? t("cliCommand.notInstalled")
      : state.onPath
        ? t("cliCommand.installedOnPath", { path: state.installedPath })
        : state.pathSetup?.added
          ? t("cliCommand.installedPathAdded", {
              path: state.installedPath,
              file: state.pathSetup.file,
            })
          : t("cliCommand.installedNotOnPath", {
              path: state.installedPath,
              hint: state.pathSetup ? "" : t("cliCommand.addFolderHint"),
            });

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              {t("cliCommand.addToPath")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? t("cliCommand.remove") : t("cliCommand.install")}
          </Button>
        </div>
      }
    />
  );
}
