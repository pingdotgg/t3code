import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { CodexSetupSection } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";

export function ProviderWizardAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly onFinish: () => void;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const settings = useEnvironmentSettings(environmentId);
  const instance = settings.providerInstances[instanceId];
  const instanceConfig =
    instance?.config !== null && typeof instance?.config === "object" ? instance.config : {};
  const isolated = "isolateRuntime" in instanceConfig && instanceConfig.isolateRuntime === true;
  const mode = readCodexSetupMode(instanceConfig);
  const codexSetup = instance?.driver === "codex" && (isolated || mode === "managed");
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, "Codex setup settings");
  const query = useEnvironmentQuery(
    codexSetup && !provider?.setup?.canAuthenticate
      ? null
      : serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const auth = query.data;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider?.auth.status === "authenticated" ||
    (provider?.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering = !signedIn && !query.error && auth?.methods === undefined;
  const canAuthenticate = (auth?.methods?.length ?? 0) > 0;

  return (
    <>
      <WizardPanel className="min-h-72">
        <SettingsGroup variant="plain">
          {codexSetup ? (
            <CodexSetupSection
              environmentId={environmentId}
              instanceId={instanceId}
              provider={provider}
              mode={mode}
              isolated={isolated}
              enabled={instance.enabled !== false}
              readOnly={!canManage}
              onModeChange={(setupMode) => {
                void mutate({
                  environmentId,
                  input: {
                    patch: {},
                    providerInstanceMutation: {
                      operation: "upsert",
                      instanceId,
                      instance: {
                        ...instance,
                        enabled: true,
                        config: { ...instanceConfig, enabled: true, setupMode },
                      },
                    },
                  },
                });
              }}
            />
          ) : provider && (canAuthenticate || signedIn) ? (
            <ProviderAuthenticationSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={{
                ...provider,
                setup: {
                  ...provider.setup,
                  canInstall: provider.setup?.canInstall ?? false,
                  canAuthenticate,
                },
              }}
              readOnly={false}
            />
          ) : (
            <SettingsRow
              title="Account"
              description={
                isDiscovering
                  ? "Discovering sign-in methods…"
                  : (query.error ??
                    auth?.message ??
                    "No in-app sign-in advertised. Follow the provider's docs to finish setup.")
              }
              control={
                isDiscovering ? (
                  <Button disabled size="sm" variant="outline">
                    Sign in
                  </Button>
                ) : provider?.setup?.documentationUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                    }
                  >
                    Open docs
                  </Button>
                ) : undefined
              }
            />
          )}
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        <Button
          size="sm"
          variant={signedIn ? "default" : "outline"}
          disabled={active}
          onClick={onFinish}
        >
          {signedIn ? "Done" : "Skip for now"}
        </Button>
      </WizardFooter>
    </>
  );
}
