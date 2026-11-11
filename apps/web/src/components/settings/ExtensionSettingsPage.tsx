import { useExtensionPanelContent } from "./useExtensionPanelContent";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  extensionCommandValue,
  extensionFailureMessage,
} from "@t3tools/client-runtime/state/extensions";
import type { EnvironmentId, ExtensionInfo } from "@t3tools/contracts";
import { extensionEnvironment } from "../../state/extensions";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsPageContainer } from "./settingsLayout";
import { useExtensionSettingsPages } from "./useExtensionSettingsPages";
import { ExtensionSettingsFields } from "./ExtensionSettingsFields";
import { ExtensionPanel } from "./ExtensionPanel";

export function ExtensionSettingsPage({
  extensionId,
  pageId,
}: {
  extensionId: string;
  pageId: string;
}) {
  const { environmentId, pages } = useExtensionSettingsPages();
  const selection = pages.find(
    ({ entry, page }) => entry.manifest.id === extensionId && page.id === pageId,
  );
  if (!selection || !environmentId)
    return (
      <SettingsPageContainer>
        <p>This extension page is unavailable on the selected environment.</p>
      </SettingsPageContainer>
    );
  return (
    <Page
      key={`${environmentId}:${extensionId}:${pageId}:${selection.entry.runtimeId ?? "stopped"}`}
      environmentId={environmentId}
      {...selection}
    />
  );
}

function Page({
  environmentId,
  entry,
  page,
}: {
  environmentId: EnvironmentId;
  entry: ExtensionInfo;
  page: NonNullable<ExtensionInfo["manifest"]["settingsPages"]>[number];
}) {
  const [error, setError] = useState<string | null>(null);
  const settings = useAtomCommand(extensionEnvironment.settings);
  const permission = useAtomValue(extensionEnvironment.settings.permissionAtom(environmentId));
  const html = useExtensionPanelContent(environmentId, entry, page.panelId);
  return (
    <SettingsPageContainer>
      <h2 className="text-lg font-semibold">{page.title}</h2>
      <p className="text-sm text-muted-foreground">
        {page.description ?? entry.manifest.description}
      </p>
      {entry.status !== "running" && (
        <p role="alert">
          {entry.diagnostic ?? "This extension is not running. Reload it in Extensions."}
        </p>
      )}
      <div className="space-y-4 py-4">
        <ExtensionSettingsFields
          entry={entry}
          keys={page.settings ?? []}
          disabled={!permission}
          save={(key, value) => {
            void settings({
              environmentId,
              input: { id: entry.manifest.id, settings: { [key]: value } },
            })
              .then((result) => {
                extensionCommandValue(result);
                setError(null);
              })
              .catch((cause: unknown) => setError(extensionFailureMessage(cause)));
          }}
        />
        {(error || html.error) && <p role="alert">{error ?? html.error}</p>}
        {html.isPending && !html.data && <p>Loading panel...</p>}
        {html.data && (
          <ExtensionPanel
            environmentId={environmentId}
            entry={entry}
            title={page.title}
            html={html.data}
          />
        )}
      </div>
    </SettingsPageContainer>
  );
}
