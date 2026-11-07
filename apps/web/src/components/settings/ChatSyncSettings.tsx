import type { ChatSyncStatus } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

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
    return `Syncing… takes a few minutes; OminaX restarts for about 30 seconds near the end.${status.message ? ` ${status.message}` : ""}`;
  }
  if (status.state === "succeeded") {
    if (status.addedChats !== null) {
      return status.addedChats === 0
        ? "Last sync: no new chats"
        : `Last sync: ${status.addedChats} new ${status.addedChats === 1 ? "chat" : "chats"}`;
    }
    return `Last sync: ${status.message ?? "finished"}`;
  }
  return status.state === "failed" ? `Last sync failed: ${status.message ?? "unknown error"}` : "";
}

export function ChatSyncSection() {
  const { connectedEnvironments } = useSettingsScope();
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
    setPending(true);
    await Promise.all(
      supported.map((environment, index) =>
        permissions[index] === true
          ? start({ environmentId: environment.environmentId, input: {} })
          : null,
      ),
    );
    setPending(false);
  };
  const text = statuses
    .map((query) => (query._tag === "Success" ? statusText(query.value) : ""))
    .find((value) => value.length > 0);
  return (
    <SettingsSection id="chat-sync" title="T3 Code">
      <SettingsRow
        {...searchableSetting("chat-sync")}
        serverScoped
        description="Adds the T3 Code chats this server doesn't have yet, restarting OminaX for about 30 seconds. It waits while any agent is still alive, and chats active in the last hour wait for a later sync."
        status={text}
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
