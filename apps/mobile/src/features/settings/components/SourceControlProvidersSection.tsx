import { useAtomValue } from "@effect/atom-react";
import { isSourceControlProviderOffered } from "@t3tools/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  readHostCredentialSettings,
  sourceControlClients,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  SettingsSecretValue,
  SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Linking, Platform, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import { ConnectionFormField } from "../../connection/ConnectionFormField";
import { SourceControlIcon } from "../../projects/SourceControlIcon";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsProviderRow } from "./SettingsProviderRow";
import { SettingsSection } from "./SettingsSection";

const saveFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The settings could not be saved.";
};

const hasToken = (token: SettingsSecretValue | undefined) =>
  typeof token === "string" ? token.length > 0 : token !== undefined;

export const sourceControlProviderReady = (item: SourceControlProviderDiscoveryItem) =>
  item.status === "available" && item.auth.status === "authenticated";

/** The line under a provider's name: whether it works on this server, and what to do if not. */
export function sourceControlProviderSummary(item: SourceControlProviderDiscoveryItem): string {
  if (item.status !== "available") return `Not available on this server: ${item.installHint}`;
  const { auth } = item;
  const detail = Option.getOrNull(auth.detail);
  if (auth.status === "authenticated") {
    const account = Option.getOrNull(auth.account);
    return ["Authenticated", account ? `as ${account}` : null, detail ? `· ${detail}` : null]
      .filter(Boolean)
      .join(" ");
  }
  if (auth.status === "unauthenticated") {
    if (!item.executable) return `Available. ${item.installHint}`;
    if (auth.accounts?.some((entry) => entry.authenticated))
      return detail ?? `Every ${item.label} host is turned off.`;
    return `Not authenticated on this server. Sign in with the ${item.executable} tool on the server host, or save a token here.`;
  }
  return `Could not verify ${item.label}. ${detail ?? item.installHint}`;
}

/**
 * Every hosting integration each selected environment knows: whether it works there, whether
 * the project pickers offer it, and its credentials where the app can set them.
 */
export function SourceControlProvidersSection(props: {
  readonly environments: readonly SettingsTarget[];
  readonly canWrite: (environmentId: EnvironmentId) => boolean;
}) {
  return (
    <>
      {props.environments.map((environment) => (
        <EnvironmentProviders
          key={environment.environmentId}
          environment={environment}
          title={
            props.environments.length > 1
              ? `Source control providers · ${environment.label}`
              : "Source control providers"
          }
          disabled={!props.canWrite(environment.environmentId)}
        />
      ))}
    </>
  );
}

function EnvironmentProviders(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
  readonly disabled: boolean;
}) {
  const { environment } = props;
  const { environmentId } = environment;
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save source control providers",
  });
  const navigation = useNavigation();
  const items = discovery.data?.sourceControlProviders ?? [];
  const offered = environment.serverConfig.settings.offeredSourceControlProviders;
  const disabled = props.disabled || !canUpdate;
  if (items.length === 0) {
    return discovery.error ? (
      <SettingsSection title={props.title} footer={discovery.error}>
        <View className="p-4">
          <Button label="Scan again" tone="secondary" onPress={discovery.refresh} />
        </View>
      </SettingsSection>
    ) : null;
  }
  return (
    <SettingsSection title={props.title}>
      {items.map((item, index) => {
        const definition = sourceControlClients.find(item.kind);
        return (
          <SettingsProviderRow
            key={item.kind}
            icon={
              <SourceControlIcon
                icon={definition?.icon ?? null}
                size={Platform.OS === "android" ? 20 : 18}
                colorClassName="accent-icon"
              />
            }
            label={item.label}
            detail={Option.getOrNull(item.version)}
            description={sourceControlProviderSummary(item)}
            ready={sourceControlProviderReady(item)}
            separated={index > 0}
            {...(definition?.credentials || definition?.settings
              ? {
                  onPress: () =>
                    navigation.navigate("SettingsSourceControlProvider", {
                      environmentId,
                      kind: item.kind,
                    }),
                }
              : {})}
            toggle={{
              accessibilityLabel: `Offer ${item.label} when adding or publishing a project`,
              value: isSourceControlProviderOffered(offered, item.kind),
              disabled,
              onValueChange: (value) =>
                void updateSettings({
                  environmentId,
                  input: { patch: { offeredSourceControlProviders: { [item.kind]: value } } },
                }),
            }}
          />
        );
      })}
    </SettingsSection>
  );
}

export function SourceControlTokenForm(props: {
  readonly environment: SettingsTarget;
  readonly definition: SourceControlDefinition;
  readonly credentials: SourceControlHostCredentials;
  readonly disabled: boolean;
  readonly onSaved: () => void;
}) {
  const { definition, credentials } = props;
  const { environmentId } = props.environment;
  const { tokens } = readHostCredentialSettings(
    props.environment.serverConfig.settings,
    definition.kind,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} token`,
  });
  const defaultHost = definition.publicHost ?? "";
  const [host, setHost] = useState(defaultHost);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const target = host.trim().toLowerCase();
  const saved = hasToken(tokens[target]);
  const savedHosts = Object.entries(tokens)
    .filter(([, value]) => hasToken(value))
    .map(([name]) => name);

  const save = async (token: string) => {
    if (!target) return;
    setSaving(true);
    setFailure(null);
    const result = await updateSettings({
      environmentId,
      // Send the whole map; other tokens' redaction markers preserve their values.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { tokens: { ...tokens, [target]: token } } },
        },
      },
    });
    setSaving(false);
    if (result._tag !== "Success") {
      setFailure(saveFailure(result));
      return;
    }
    setDraft("");
    props.onSaved();
  };
  const locked = props.disabled || saving;
  return (
    <View className="gap-3 p-4">
      <Text className="text-xs leading-relaxed text-foreground-muted">
        {`A token saved here is used before ${credentials.tokenEnvVar} and the ${credentials.cliName} login, so ${definition.label} works without the ${credentials.cliLabel}. Give it ${credentials.tokenAccess}.`}
      </Text>
      <ConnectionFormField
        label="Host"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={defaultHost}
        editable={!locked}
        value={host}
        onChangeText={setHost}
      />
      <SecretTextInput
        accessibilityLabel={`${definition.label} token`}
        placeholder={saved ? "Saved. Enter a new token to replace it" : "Token"}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={(value) => {
          if (value.trim()) void save(value.trim());
        }}
        editable={!locked}
      />
      <Text className="text-xs text-foreground-muted">
        {savedHosts.length === 0
          ? `No token saved; the server uses ${credentials.tokenEnvVar} or the ${credentials.cliName} login.`
          : `Saved for ${savedHosts.join(", ")}.`}
      </Text>
      {failure ? (
        <Text selectable className="text-xs text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-2">
        {target || defaultHost ? (
          <Button
            label="Create a token"
            tone="text"
            size="compact"
            onPress={() =>
              void Linking.openURL(credentials.newTokenUrl(target || defaultHost)).catch(
                () => undefined,
              )
            }
          />
        ) : null}
        {saved ? (
          <Button
            label="Remove"
            tone="secondary"
            size="compact"
            disabled={locked}
            onPress={() => void save("")}
          />
        ) : null}
        <Button
          label="Save"
          tone="primary"
          size="compact"
          loading={saving}
          disabled={locked || !target || !draft.trim()}
          onPress={() => void save(draft.trim())}
        />
      </View>
    </View>
  );
}

type HostSettings = NonNullable<SourceControlDefinition["settings"]>;

/** The fields a host declares, in its own order, with what its schema says about each. */
function hostSettingsFields(settings: HostSettings) {
  const order = Schema.resolveAnnotations(settings)?.providerSettingsFormSchema?.order ?? [];
  const position = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return Object.keys(settings.fields)
    .sort((left, right) => position(left) - position(right))
    .flatMap((key) => {
      const field = settings.fields[key]!;
      const annotations = Schema.resolveAnnotationsKey(field) ?? Schema.resolveAnnotations(field);
      const form = annotations?.providerSettingsForm ?? {};
      if (form.hidden) return [];
      return [
        {
          key,
          label: typeof annotations?.title === "string" ? annotations.title : key,
          description:
            typeof annotations?.description === "string" ? annotations.description : undefined,
          placeholder: form.placeholder,
          secret: form.control === "password",
        },
      ];
    });
}

/** Credentials for a host that names its own fields rather than one token per host. */
export function SourceControlHostFieldsForm(props: {
  readonly environment: SettingsTarget;
  readonly definition: SourceControlDefinition;
  readonly settings: HostSettings;
  readonly disabled: boolean;
  readonly onSaved: () => void;
}) {
  const { definition } = props;
  const { environmentId } = props.environment;
  const saved: Readonly<Record<string, unknown>> =
    props.environment.serverConfig.settings.sourceControlHosts[definition.kind] ?? {};
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} settings`,
  });
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fields = hostSettingsFields(props.settings);
  const isSet = (key: string) => {
    const value = saved[key];
    return typeof value === "string" ? value.length > 0 : value !== undefined;
  };
  const changed = Object.fromEntries(
    Object.entries(drafts).flatMap(([key, value]) => (value.trim() ? [[key, value.trim()]] : [])),
  );
  const save = async (patch: Record<string, string>) => {
    setSaving(true);
    setFailure(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { [definition.kind]: patch } } },
    });
    setSaving(false);
    if (result._tag !== "Success") {
      setFailure(saveFailure(result));
      return;
    }
    setDrafts({});
    props.onSaved();
  };
  const locked = props.disabled || saving;
  const submit = () => {
    if (Object.keys(changed).length > 0) void save(changed);
  };
  return (
    <View className="gap-4 p-4">
      {fields.map((field) => (
        <View key={field.key} className="gap-1.5">
          {field.secret ? (
            <>
              <Text className="text-xs font-t3-bold text-foreground-muted">{field.label}</Text>
              <SecretTextInput
                accessibilityLabel={field.label}
                placeholder={
                  isSet(field.key) ? "Saved. Enter a new value to replace it" : field.label
                }
                value={drafts[field.key] ?? ""}
                onChangeText={(value) => setDrafts({ ...drafts, [field.key]: value })}
                onSubmitEditing={submit}
                editable={!locked}
              />
            </>
          ) : (
            <ConnectionFormField
              label={field.label}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={
                typeof saved[field.key] === "string" && saved[field.key] !== ""
                  ? String(saved[field.key])
                  : field.placeholder
              }
              editable={!locked}
              value={drafts[field.key] ?? ""}
              onChangeText={(value) => setDrafts({ ...drafts, [field.key]: value })}
              onSubmitEditing={submit}
            />
          )}
          {field.description ? (
            <Text className="text-xs text-foreground-muted">{field.description}</Text>
          ) : null}
        </View>
      ))}
      {failure ? (
        <Text selectable className="text-xs text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-2">
        {fields.some((field) => isSet(field.key)) ? (
          <Button
            label="Remove"
            tone="secondary"
            size="compact"
            disabled={locked}
            onPress={() => void save(Object.fromEntries(fields.map((field) => [field.key, ""])))}
          />
        ) : null}
        <Button
          label="Save"
          tone="primary"
          size="compact"
          loading={saving}
          disabled={locked || Object.keys(changed).length === 0}
          onPress={submit}
        />
      </View>
    </View>
  );
}
