import type { ChatSyncStatus } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const chatSyncStatusesAtom = environmentAtomList("web-chat-sync-statuses", (environmentId) =>
  serverEnvironment.chatSyncStatus({ environmentId, input: {} }),
);
const chatSyncPermissionsAtom = environmentAtomList(
  "web-chat-sync-permissions",
  serverEnvironment.startChatSync.permissionAtom,
);

function statusText(status: ChatSyncStatus): string {
  if (status.state === "running") {
    return `Syncing… takes a few minutes; T3 Learn reconnects for a few seconds near the end.${status.message ? ` ${status.message}` : ""}`;
  }
  if (status.state === "succeeded") {
    if (status.addedChats !== null) {
      return status.addedChats === 0
        ? "No new chats"
        : `${status.addedChats} new ${status.addedChats === 1 ? "chat" : "chats"}`;
    }
    return status.message ?? "Sync finished";
  }
  return status.state === "failed" ? `Sync failed: ${status.message ?? "Unknown error"}` : "";
}

export function ChatSyncSection() {
  const { connectedEnvironments } = useSettingsScope();
  const [startError, setStartError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const start = useAtomCommand(serverEnvironment.startChatSync);
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.chatSync === true,
  );
  const ids = supported.map((environment) => environment.environmentId);
  const statuses = useAtomValue(chatSyncStatusesAtom(environmentIdsKey(ids)));
  const permissions = useAtomValue(chatSyncPermissionsAtom(environmentIdsKey(ids)));
  if (supported.length === 0) return null;
  const running = statuses.some(
    (query) => query._tag === "Success" && query.value.state === "running",
  );
  const run = async () => {
    if (pending) return;
    setPending(true);
    setStartError(null);
    const results = await Promise.all(
      supported.map(async (environment, index) => {
        if (permissions[index] !== true) return null;
        const result = await start({ environmentId: environment.environmentId, input: {} });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          return String(squashAtomCommandFailure(result));
        }
        return null;
      }),
    ).catch((error: unknown) => {
      setStartError(String(error));
      return null;
    });
    if (results !== null) {
      setStartError(results.find((message) => message !== null) ?? null);
    }
    setPending(false);
  };
  const text = statuses
    .map((query) => (query._tag === "Success" ? statusText(query.value) : ""))
    .find((value) => value.length > 0);
  return (
    <SettingsSection id="chat-sync" title="T3 Code" variant="plain">
      <SettingsRow
        {...searchableSetting("chat-sync")}
        serverScoped
        description="Adds the T3 Code chats this server doesn't have yet. Chats active in the last hour wait for a later sync."
        status={startError ?? text}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={pending || running || !permissions.some(Boolean)}
            onClick={() => void run()}
          >
            Sync
          </Button>
        }
      />
    </SettingsSection>
  );
}
