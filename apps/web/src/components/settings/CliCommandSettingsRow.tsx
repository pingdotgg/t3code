import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useMessages } from "gt-react";
import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { m } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const FAILURE_TITLES = {
  install: msg("Could not install hyakki"),
  uninstall: msg("Could not remove hyakki"),
  addToPath: msg("Could not add hyakki to PATH"),
} as const;

/** The desktop `hyakki` command's state, and its actions with a toast on failure. */
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
  const description = state.shadowedBy
    ? resolve(
        msg("Another hyakki at {path} runs first in a new terminal. Remove it to use Hyakki's.", {
          path: state.shadowedBy,
        }),
      )
    : !installed
      ? resolve(msg("Run Hyakki's CLI as `hyakki` from any terminal."))
      : state.onPath
        ? resolve(
            msg("Installed at {path}. Open a new terminal to use it.", {
              path: state.installedPath,
            }),
          )
        : state.pathSetup?.added
          ? resolve(
              msg(
                "Installed at {path} and added to PATH in {file}. Open a new terminal to use it.",
                { path: state.installedPath, file: state.pathSetup.file },
              ),
            )
          : state.pathSetup
            ? resolve(
                msg("Installed at {path}, which is not on your PATH yet.", {
                  path: state.installedPath,
                }),
              )
            : resolve(
                msg(
                  "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `hyakki`.",
                  { path: state.installedPath },
                ),
              );

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
              ? resolve(msg("Remove", { $context: "verb, uninstalls the hyakki command" }))
              : resolve(msg("Install", { $context: "verb, installs the hyakki command" }))}
          </Button>
        </div>
      }
    />
  );
}
