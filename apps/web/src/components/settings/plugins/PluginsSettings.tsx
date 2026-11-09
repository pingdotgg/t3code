import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { BlocksIcon } from "lucide-react";
import { type DragEvent, useState } from "react";

import { cn } from "../../../lib/utils";
import { pluginUiEnvironmentsAtom } from "../../../plugins/pluginFollow";
import { droppedFolders } from "../../../plugins/pluginFolders";
import type { EnvironmentPresentation } from "../../../state/environments";
import { pluginEnvironment } from "../../../state/plugins";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { useSettingsScope } from "../SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import {
  AddPluginButton,
  AddPluginDialog,
  InstallProblems,
  usePluginInstaller,
} from "./PluginInstallControls";
import { PluginList } from "./PluginList";
import { runsPlugins } from "./pluginTargets";
import { PluginUiEnvironmentRow } from "./PluginUiEnvironmentRow";

export function PluginsSettings() {
  const { scope, environment } = useSettingsScope();
  if (scope.kind === "unavailable") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  if (environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Plugins" variant="plain">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BlocksIcon />
              </EmptyMedia>
              <EmptyTitle>No environment selected</EmptyTitle>
              <EmptyDescription>Connect an environment to manage its plugins.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <PluginsPage environment={environment} />;
}

const NO_INSTALL_PERMISSION = Atom.make(false);

/** Lists the environment's plugins. Plugin folders dropped anywhere on it are installed. */
function PluginsPage({ environment }: { readonly environment: EnvironmentPresentation }) {
  const loadsUi = useAtomValue(pluginUiEnvironmentsAtom).includes(environment.environmentId);
  const installer = usePluginInstaller(environment, loadsUi);
  const [adding, setAdding] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const runs = runsPlugins(environment);
  const canInstall = useAtomValue(
    runs
      ? pluginEnvironment.createPluginUploadUrl.permissionAtom(environment.environmentId)
      : NO_INSTALL_PERMISSION,
  );
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <SettingsPageContainer>
      {/* Drops on the Add plugin dialog land here too: React bubbles events out of portals. */}
      <div
        className={cn(
          "-m-3 flex flex-col gap-8 rounded-xl p-3",
          dragActive &&
            "bg-primary/5 outline-2 -outline-offset-2 outline-primary/60 outline-dashed",
        )}
        onDragEnter={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(canInstall);
        }}
        onDragOver={(event) => {
          if (!isFileDrag(event)) return;
          // Taken even without permission, so the browser doesn't open the folder instead.
          event.preventDefault();
          event.dataTransfer.dropEffect = canInstall ? "copy" : "none";
          setDragActive(canInstall);
        }}
        onDragLeave={(event) => {
          if (!isFileDrag(event)) return;
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragActive(false);
          if (!canInstall) return;
          void installer
            .installFolders(droppedFolders(event.dataTransfer))
            .then((installed) => installed && setAdding(false));
        }}
      >
        {runs ? (
          <PluginList environmentId={environment.environmentId}>
            <SettingsRow
              title="Add a plugin"
              description={
                installer.installing === null
                  ? "Drop a plugin folder here or use Add plugin. Install only plugins you trust."
                  : `Installing ${installer.installing}…`
              }
              control={
                <AddPluginButton
                  environmentId={environment.environmentId}
                  disabled={installer.installing !== null}
                  onClick={() => {
                    installer.clearProblems();
                    setAdding(true);
                  }}
                />
              }
            >
              {installer.problems.length > 0 ? (
                <InstallProblems problems={installer.problems} />
              ) : null}
            </SettingsRow>
            <PluginUiEnvironmentRow />
          </PluginList>
        ) : (
          <SettingsSection title="Plugins">
            <SettingsRow
              title="Plugins are not available"
              description={`${environment.label} runs a T3 Code server without plugin support.`}
            />
          </SettingsSection>
        )}
        {runs ? (
          <AddPluginDialog
            environmentId={environment.environmentId}
            open={adding}
            onOpenChange={setAdding}
            installer={installer}
            dragActive={dragActive}
            scopeNote={
              loadsUi
                ? `Installs on ${environment.label}.`
                : `Installs on ${environment.label}. This app doesn't load plugin UI from ${environment.label}, so a plugin with no server code does nothing there.`
            }
          />
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}
