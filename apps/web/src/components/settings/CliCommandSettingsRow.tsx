import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useMessages } from "gt-react";
import { APP_NAME, CLI_COMMAND } from "@t3tools/shared/branding";
import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  installedCliCommand,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { m } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const FAILURE_TITLES = {
  install: `Could not install ${CLI_COMMAND}`,
  uninstall: `Could not remove ${CLI_COMMAND}`,
  addToPath: `Could not add ${CLI_COMMAND} to PATH`,
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
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
            title: m(FAILURE_TITLES[action]),
            description:
              error instanceof Error
                ? (thrownErrorMessage(error, m) ?? error.message)
                : m(msg("Something went wrong.")),
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
  const searchableSetting = useSearchableSetting();
  const { state, busy, run } = useDesktopCliCommand();
  const resolve = useMessages();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const command = installedCliCommand(state);
  const blocked = state.aliasBlockedBy
    ? ` Another ${CLI_COMMAND} at ${state.aliasBlockedBy} was left in place.`
    : "";
  const description = state.shadowedBy
    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use ${APP_NAME}'s.`
    : !installed
      ? `Run ${APP_NAME}'s CLI as \`${CLI_COMMAND}\` from any terminal.`
      : state.onPath
        ? `Installed at ${state.installedPath}.${blocked} Open a new terminal and run \`${command}\`.`
        : state.pathSetup?.added
          ? `Installed at ${state.installedPath} and added to PATH in ${state.pathSetup.file}.${blocked} Open a new terminal and run \`${command}\`.`
          : `Installed at ${state.installedPath}, which is not on your PATH yet.${blocked}${state.pathSetup ? "" : ` Add its folder to your PATH to run \`${command}\`.`}`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              <T>Add to PATH</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed
              ? resolve(msg("Remove", { $context: "verb, uninstalls the t3 command" }))
              : resolve(msg("Install", { $context: "verb, installs the t3 command" }))}
          </Button>
        </div>
      }
    />
  );
}
