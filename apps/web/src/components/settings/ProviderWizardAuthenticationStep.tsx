import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

/** Sign-in uses the saved instance's environment and credentials, just like chat. */
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

  // The server builds the instance after the settings write lands. Sign-in
  // state only exists once the instance does, so wait for its snapshot.
  return provider ? (
    <ProviderWizardSignIn
      environmentId={environmentId}
      environmentLabel={environmentLabel}
      instanceId={instanceId}
      provider={provider}
      onFinish={onFinish}
    />
  ) : (
    <WizardSignInLayout signedIn={false} active={false} onFinish={onFinish}>
      <SettingsRow
        title="Account"
        description="Discovering sign-in methods…"
        control={
          <Button disabled size="sm" variant="outline">
            Sign in
          </Button>
        }
      />
    </WizardSignInLayout>
  );
}

function ProviderWizardSignIn({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly onFinish: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const auth = query.data;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering = !signedIn && !query.error && auth?.methods === undefined;
  const canAuthenticate = (auth?.methods?.length ?? 0) > 0;

  return (
    <WizardSignInLayout signedIn={signedIn} active={active} onFinish={onFinish}>
      {canAuthenticate || signedIn ? (
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
            ) : provider.setup?.documentationUrl ? (
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
    </WizardSignInLayout>
  );
}

function WizardSignInLayout({
  signedIn,
  active,
  onFinish,
  children,
}: {
  readonly signedIn: boolean;
  readonly active: boolean;
  readonly onFinish: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      <WizardPanel>
        <div className="min-h-72">
          <SettingsGroup variant="plain">{children}</SettingsGroup>
        </div>
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
