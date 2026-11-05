import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

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
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
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
          {provider && (canAuthenticate || signedIn) ? (
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
              title={t({ message: "Account" })}
              description={
                isDiscovering
                  ? t({ message: "Discovering sign-in methods…" })
                  : (query.error ??
                    auth?.message ??
                    t({
                      message:
                        "No in-app sign-in advertised. Follow the provider's docs to finish setup.",
                    }))
              }
              control={
                isDiscovering ? (
                  <Button disabled size="sm" variant="outline">
                    <Trans>Sign in</Trans>
                  </Button>
                ) : provider?.setup?.documentationUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                    }
                  >
                    <Trans>Open docs</Trans>
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
          {signedIn ? <Trans>Done</Trans> : <Trans>Skip for now</Trans>}
        </Button>
      </WizardFooter>
    </>
  );
}
