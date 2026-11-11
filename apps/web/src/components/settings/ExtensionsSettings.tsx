import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, PuzzleIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironment } from "../../state/environments";
import { extensionEnvironment } from "../../state/extensions";
import { useEnvironmentQuery } from "../../state/query";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { Button } from "../ui/button";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionInstallForm } from "./ExtensionInstallForm";

export function ExtensionsSettings() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Extensions</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Add tools, commands, and custom views to T3 Code. Extensions run on the selected server
          and are available on your connected devices.
        </p>
      </div>
      {environment ? (
        <ExtensionManager
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p>Select a connected environment to manage its extensions.</p>
      )}
    </SettingsPageContainer>
  );
}

function ExtensionManager({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.extensions === true;
  const query = useEnvironmentQuery(
    supported ? extensionEnvironment.state({ environmentId, input: {} }) : null,
  );
  const permission = useAtomValue(extensionEnvironment.install.permissionAtom(environmentId));
  const [adding, setAdding] = useState(false);
  if (!supported) return <p>Update T3 Code on this environment to use extensions.</p>;
  const entries = query.data ?? [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Installed</h3>
          <p className="text-xs text-muted-foreground">
            {entries.length} installed,{" "}
            {entries.filter((entry) => entry.status === "running").length} running
          </p>
        </div>
        <Button
          size="sm"
          variant={adding ? "outline" : "default"}
          disabled={!permission}
          onClick={() => setAdding(!adding)}
        >
          <PlusIcon />
          {adding ? "Cancel" : "Add extension"}
        </Button>
      </div>
      {(adding || (entries.length === 0 && query.data !== null)) && (
        <ExtensionInstallForm
          environmentId={environmentId}
          baseDirectory={environment?.serverConfig?.settings.addProjectBaseDirectory}
          platform={environment?.serverConfig?.environment.platform.os ?? ""}
          onInstalled={() => setAdding(false)}
        />
      )}
      {query.error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {query.error}
        </p>
      )}
      {query.isPending && !query.data && (
        <p className="text-sm text-muted-foreground">Loading extensions...</p>
      )}
      {query.data?.length === 0 && (
        <div className="flex items-start gap-3 py-4 text-muted-foreground">
          <PuzzleIcon className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Your extensions will appear here</p>
            <p className="mt-1 text-sm">
              Install a folder from this server or an npm package to get started.
            </p>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {entries.map((entry) => (
          <ExtensionCard key={entry.manifest.id} environmentId={environmentId} entry={entry} />
        ))}
      </div>
    </div>
  );
}
