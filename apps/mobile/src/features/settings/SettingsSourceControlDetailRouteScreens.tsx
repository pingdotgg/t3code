import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  hasIssueTrackerTeams,
  issueTrackerBindings,
  issueTrackerSummary,
} from "@t3tools/client-runtime/state/issue-trackers";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { T, useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import {
  IssueTrackerCredentialForm,
  IssueTrackerProjectRows,
} from "./components/IssueTrackerSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  SourceControlHostFieldsForm,
  SourceControlTokenForm,
  sourceControlProviderSummary,
} from "./components/SourceControlProvidersSection";
import { AppSignInRow } from "./components/SourceControlSignInSection";
import type { SettingsTarget } from "./settings-environment-filter";

/** The environment a detail page edits, once it is connected, and whether this session may. */
function useDetailEnvironment(environmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (entry): entry is SettingsTarget =>
      entry.environmentId === environmentId &&
      entry.connection.phase === "connected" &&
      entry.serverConfig !== null,
  );
  const writable = useEnvironmentsWithScope(
    environment ? [environment] : [],
    AuthSettingsWriteScope,
  );
  return { environment, canWrite: writable.has(environmentId) };
}

function DetailPage(props: { readonly title: string; readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

const Unavailable = () => (
  <Text className="px-2 text-base text-foreground-muted">
    <T>Connect this environment to change its settings.</T>
  </Text>
);

export function SettingsSourceControlProviderRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly kind: SourceControlProviderKind;
}>) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, kind } = route.params;
  const { environment, canWrite } = useDetailEnvironment(environmentId);
  const definition = sourceControlClients.find(kind);
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const item = discovery.data?.sourceControlProviders.find((entry) => entry.kind === kind);
  const credentials = definition?.credentials;
  const appSignIn = item?.appSignIn === true ? credentials?.appSignIn : undefined;
  const disabled = !canWrite || !canUpdate;
  return (
    <DetailPage
      title={
        definition?.label ??
        gt("Provider", { $context: "settings page of one source control provider" })
      }
    >
      {!environment || !definition ? (
        <Unavailable />
      ) : (
        <>
          {item ? (
            <Text selectable className="px-2 text-sm text-foreground-muted">
              {[Option.getOrNull(item.version), sourceControlProviderSummary(item, messages)]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
          {appSignIn ? (
            <SettingsSection
              title={gt("Sign in", { $context: "settings section title" })}
              footer={gt("A far higher API rate limit than a personal token or CLI login.")}
            >
              <AppSignInRow
                environment={environment}
                label={appSignIn.appName}
                definition={definition}
                appSignIn={appSignIn}
                disabled={disabled}
              />
            </SettingsSection>
          ) : null}
          {!credentials && definition.settings ? (
            <SettingsSection title={gt("Credentials")}>
              <SourceControlHostFieldsForm
                environment={environment}
                definition={definition}
                settings={definition.settings}
                disabled={disabled}
                onSaved={discovery.refresh}
              />
            </SettingsSection>
          ) : null}
          {credentials ? (
            <SettingsSection
              title={
                appSignIn
                  ? gt("Or use your own credentials")
                  : gt("Token", { $context: "access token field" })
              }
            >
              <SourceControlTokenForm
                environment={environment}
                definition={definition}
                credentials={credentials}
                disabled={disabled}
                onSaved={discovery.refresh}
              />
            </SettingsSection>
          ) : null}
        </>
      )}
    </DetailPage>
  );
}

export function SettingsIssueTrackerRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly tracker: string;
  readonly accountId?: string;
}>) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId } = route.params;
  const { environment, canWrite } = useDetailEnvironment(environmentId);
  const query = useEnvironmentQuery(
    issueTrackerEnvironment.connections({ environmentId, input: {} }),
  );
  const canEdit = useAtomValue(issueTrackerEnvironment.connect.permissionAtom(environmentId));
  const tracker = [...(query.data?.trackers ?? []), ...(query.data?.accounts ?? [])].find(
    (entry) => entry.tracker === route.params.tracker && entry.accountId === route.params.accountId,
  );
  const disabled = !canWrite || !canEdit;
  const usable = tracker?.connected === true && tracker.account !== null;
  const canAddAccount =
    tracker !== undefined &&
    route.params.accountId === undefined &&
    (tracker.connected ||
      (query.data?.accounts ?? []).some((account) => account.tracker === tracker.tracker)) &&
    environment?.serverConfig.environment.capabilities.issueTrackerAccounts === true;
  return (
    <DetailPage title={tracker?.displayName ?? gt("Issue tracker")}>
      {!environment || !tracker ? (
        <Unavailable />
      ) : (
        <>
          <Text selectable className="px-2 text-sm text-foreground-muted">
            {issueTrackerSummary(tracker, issueTrackerBindings(query.data), messages)}
          </Text>
          <SettingsSection title={tracker.credential.label}>
            <IssueTrackerCredentialForm
              environmentId={environmentId}
              tracker={tracker}
              disabled={disabled}
            />
          </SettingsSection>
          {usable && hasIssueTrackerTeams(tracker, issueTrackerBindings(query.data)) ? (
            <SettingsSection
              title={gt("Projects")}
              footer={gt(
                "Pick one or more {tracker} {scope}s for each project. Their issues list beside the repository's own, and agents file new issues in the first one.",
                { tracker: tracker.displayName, scope: tracker.scopeNoun },
              )}
            >
              <IssueTrackerProjectRows
                environmentId={environmentId}
                tracker={tracker}
                bindings={issueTrackerBindings(query.data)}
                refreshing={query.isPending}
                refreshFailed={query.error !== null}
                disabled={disabled}
              />
            </SettingsSection>
          ) : null}
          {canAddAccount ? (
            <SettingsSection
              title={gt("Another account")}
              footer={gt("Connect a second {tracker} workspace or user.", {
                tracker: tracker.displayName,
              })}
            >
              <IssueTrackerCredentialForm
                environmentId={environmentId}
                tracker={tracker}
                disabled={disabled}
                addAccount
              />
            </SettingsSection>
          ) : null}
        </>
      )}
    </DetailPage>
  );
}
