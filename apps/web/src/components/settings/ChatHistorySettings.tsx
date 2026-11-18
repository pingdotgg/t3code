import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { useGT } from "gt-react";

import type { EnvironmentId } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";

import { exportChatHistoryWithToast, importChatHistory } from "../../lib/chatHistoryTransfer";
import { chatHistoryEnvironment } from "../../state/chatHistory";
import { m } from "../../i18n/messages";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";

export function ChatHistorySection() {
  const { environment } = useSettingsScope();
  if (!environment) return null;
  return <ChatHistoryRows environmentId={environment.environmentId} />;
}

function ChatHistoryRows({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const canExport = useAtomValue(chatHistoryEnvironment.export.permissionAtom(environmentId));
  const canImport = useAtomValue(chatHistoryEnvironment.import.permissionAtom(environmentId));
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const runExport = () => {
    setBusy("export");
    void exportChatHistoryWithToast(environmentId, { type: "all" }).finally(() => setBusy(null));
  };

  const runImport = (file: File) => {
    setBusy("import");
    importChatHistory(environmentId, file)
      .then(({ importedCount, skippedCount }) =>
        toastManager.add({
          type: "success",
          title: gt("{count, plural, one {Added # thread} other {Added # threads}}", {
            count: importedCount,
          }),
          ...(skippedCount > 0
            ? {
                description: gt(
                  "{count, plural, one {# was already here.} other {# were already here.}}",
                  { count: skippedCount },
                ),
              }
            : {}),
        }),
      )
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: gt("Could not import threads"),
          description: thrownErrorMessage(cause, m) ?? gt("Please try again."),
        }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <SettingsSection id="chat-history" title={gt("Thread history")} variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...setting("chat-history-export")}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !canExport}
              onClick={runExport}
            >
              {busy === "export" ? gt("Exporting…") : gt("Export")}
            </Button>
          }
        />
        <SettingsRow
          {...setting("chat-history-import")}
          control={
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".gz,.json,application/gzip,application/json"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) runImport(file);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !canImport}
                onClick={() => fileInput.current?.click()}
              >
                {busy === "import" ? gt("Importing…") : gt("Import…")}
              </Button>
            </>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
