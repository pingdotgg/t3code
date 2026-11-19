import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useRef } from "react";

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { m } from "../i18n/messages";
import { primaryServerProvidersAtom } from "../state/server";
import { CommandBlock } from "./CommandBlock";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  collectProviderUpdateCandidates,
  isProviderUpdateActive,
} from "./ProviderUpdateLaunchNotification.logic";
import { toastManager } from "./ui/toast";

/** Announce each available provider version once per client session, using the server's command. */
export function ProviderUpdateLaunchNotification() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const shown = useRef(new Set<string>());
  const notices = useRef(new Map<string, ReturnType<typeof toastManager.add>>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles server version advisories with the external toast manager
  useEffect(() => {
    const candidates = collectProviderUpdateCandidates(providers).filter(
      (provider) => !isProviderUpdateActive(provider),
    );
    const active = new Set(
      candidates.map((provider) => `${provider.driver}:${provider.versionAdvisory.latestVersion}`),
    );
    for (const [key, id] of notices.current) {
      if (!active.has(key)) {
        toastManager.close(id);
        notices.current.delete(key);
      }
    }
    for (const provider of candidates) {
      const advisory = provider.versionAdvisory;
      const key = `${provider.driver}:${advisory.latestVersion}`;
      const command = advisory.updateCommand;
      if (shown.current.has(key) || command === null) continue;
      shown.current.add(key);
      const name = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
      const current = advisory.currentVersion ?? provider.version;
      notices.current.set(
        key,
        toastManager.add({
          type: "info",
          title: m(
            msg("{provider} {version} is available", {
              provider: name,
              version: advisory.latestVersion,
            }),
          ),
          description: current
            ? m(
                msg("You''re on {version}. New sessions will use the updated provider.", {
                  version: current,
                }),
              )
            : m(msg("New sessions will use the updated provider.")),
          timeout: 0,
          actionProps: {
            children: m(msg("Copy update command")),
            onClick: () => {
              void writeTextToClipboard(command, {
                target: "update command",
                unavailableMessage: msg("Clipboard API is unavailable while copying update command."),
                failureMessage: msg("Failed to copy update command to the clipboard."),
              });
            },
          },
          data: {
            variant: "notification",
            leadingIcon: (
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={name}
                className="size-4.5"
              />
            ),
            body: <CommandBlock command={command} compact />,
          },
        }),
      );
    }
  }, [providers]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes this coordinator's external notices when its authenticated shell unmounts
  useEffect(() => {
    const owned = notices.current;
    return () => {
      for (const id of owned.values()) toastManager.close(id);
    };
  }, []);
  return null;
}
