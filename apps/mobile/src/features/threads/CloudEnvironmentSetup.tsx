import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Alert, Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderCloudConfiguration,
  ProviderCloudEnvironmentMutation,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  mutateCloudEnvironment,
  providerCloudConfiguration,
  providerCloudRepositories,
} from "../../state/cloud-runs";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/** Uses the host's cloud account for setup from either mobile connection mode. */
export function CloudEnvironmentSetup(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  configId?: string | undefined;
  onSetup: (config: ProviderCloudConfiguration) => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canOperate = useAtomValue(mutateCloudEnvironment.permissionAtom(props.environmentId));
  const mutate = useAtomCommand(mutateCloudEnvironment);
  const repositories = useEnvironmentQuery(
    !props.configId
      ? providerCloudRepositories({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, query },
        })
      : null,
  );
  const configuration = useEnvironmentQuery(
    props.configId
      ? providerCloudConfiguration({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, id: props.configId },
        })
      : null,
  );
  const run = async (input: ProviderCloudEnvironmentMutation) => {
    if (busy || !canOperate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "The request failed. Refresh before retrying; it may have completed.",
        );
        return;
      }
      props.onChanged();
      if (input.operation === "create" && result.value) props.onSetup(result.value);
      else if (input.operation === "delete") props.onBack();
      else configuration.refresh();
    } finally {
      setBusy(false);
    }
  };
  const button = (
    label: string,
    onPress: () => void,
    disabled = false,
    tone: "primary" | "plain" | "danger" = "plain",
  ) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className={`items-center rounded-xl p-3 ${tone === "primary" ? "bg-primary" : tone === "plain" ? "bg-grouped-card" : ""} ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        className={
          tone === "primary"
            ? "font-t3-medium text-primary-foreground"
            : tone === "danger"
              ? "text-sm text-danger-foreground"
              : "text-foreground"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
  const config = configuration.data;
  const ready = config?.revision !== null && config?.revision !== undefined;
  const field = (label: string, value: string) => (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <Text className="text-sm text-foreground">{value}</Text>
    </View>
  );
  return (
    <View className="gap-3">
      {props.configId ? (
        <>
          <View className="flex-row items-start gap-2">
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-base font-semibold text-foreground">
                {config?.name ?? "Cloud environment"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {!config
                  ? configuration.isPending
                    ? "Loading configuration…"
                    : "Could not load this environment."
                  : config.published
                    ? "Published. New cloud tasks start from this environment."
                    : ready
                      ? "Setup is ready to publish."
                      : "Not published. Finish the setup conversation to publish it."}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh configuration"
              disabled={configuration.isPending}
              onPress={configuration.refresh}
              hitSlop={8}
              className="min-h-8 justify-center px-1 active:opacity-70 disabled:opacity-40"
            >
              <Text className="font-t3-medium text-xs text-primary">Refresh</Text>
            </Pressable>
          </View>
          {config ? (
            <>
              {field(
                "Repositories",
                config.repositories.map((repo) => `${repo.id} @ ${repo.ref}`).join(", ") || "None",
              )}
              {field("Directory", config.cwd || "Default")}
              {field("Install", config.installScript || "None")}
              {field("Start skill", config.startSkill || "None")}
              {button(
                busy ? "Publishing…" : config.published ? "Republish" : "Publish environment",
                () =>
                  void run({ instanceId: props.instanceId, operation: "publish", id: config.id }),
                busy || !canOperate || !ready,
                "primary",
              )}
              {!config.published
                ? button("Continue setup", () => props.onSetup(config), busy || !canOperate)
                : null}
              {button(
                "Delete environment",
                () =>
                  Alert.alert(
                    "Delete cloud environment?",
                    "This removes the saved environment from Codex Cloud.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () =>
                          void run({
                            instanceId: props.instanceId,
                            operation: "delete",
                            id: config.id,
                          }),
                      },
                    ],
                  ),
                busy || !canOperate,
                "danger",
              )}
            </>
          ) : null}
        </>
      ) : (
        <>
          <Text className="text-base font-semibold text-foreground">
            Create a cloud environment
          </Text>
          <TextInput
            accessibilityLabel="Environment name"
            placeholder="Environment name"
            value={name}
            maxLength={200}
            onChangeText={setName}
            className="rounded-xl bg-grouped-card p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Search connected repositories"
            placeholder="Search connected repositories"
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => setQuery(search)}
            className="rounded-xl bg-grouped-card p-3 text-foreground"
          />
          {button("Search", () => setQuery(search))}
          {repositories.isPending ? <Text>Loading repositories…</Text> : null}
          {(repositories.data ?? []).map((repo) => (
            <Pressable
              key={repo.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ids.includes(repo.id) }}
              onPress={() =>
                setIds((current) =>
                  current.includes(repo.id)
                    ? current.filter((id) => id !== repo.id)
                    : [...current, repo.id],
                )
              }
              className="flex-row items-center gap-2 p-3"
            >
              <Text className="text-foreground">
                {ids.includes(repo.id) ? "☑" : "☐"} {repo.name}
              </Text>
            </Pressable>
          ))}
          <Text className="text-sm text-foreground-muted">
            Codex creates a private environment with package registry access. Setup opens in a
            separate draft; your current prompt stays saved.
          </Text>
          {button(
            busy ? "Creating…" : "Get started",
            () =>
              void run({
                instanceId: props.instanceId,
                operation: "create",
                name: name.trim(),
                repositoryIds: ids,
                network: "package_managers",
              }),
            busy || !canOperate || !name.trim() || !ids.length,
            "primary",
          )}
        </>
      )}
      {error || repositories.error || configuration.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? repositories.error ?? configuration.error}
        </Text>
      ) : null}
      {button("Back to environments", props.onBack, busy)}
    </View>
  );
}

/**
 * Sits above the composer in a thread that runs in a Codex Cloud environment
 * configuration, such as its setup conversation, so the environment can be
 * published from where it was prepared.
 */
export function CloudEnvironmentSetupBar(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  configId: string;
}) {
  const [busy, setBusy] = useState(false);
  const canOperate = useAtomValue(mutateCloudEnvironment.permissionAtom(props.environmentId));
  const mutate = useAtomCommand(mutateCloudEnvironment);
  const configuration = useEnvironmentQuery(
    providerCloudConfiguration({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, id: props.configId },
    }),
  );
  const config = configuration.data;
  if (!config) return null;
  const publish = async () => {
    setBusy(true);
    try {
      const result = await mutate({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, operation: "publish", id: config.id },
      });
      if (result._tag === "Success") configuration.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="cloud" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {config.name} · {config.published ? "Published" : "Setup draft"}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !canOperate || config.revision === null}
        onPress={() => void publish()}
        hitSlop={8}
        className="min-h-8 justify-center px-1 active:opacity-70 disabled:opacity-40"
      >
        <Text className="font-t3-medium text-xs text-primary">
          {busy ? "Publishing…" : config.published ? "Republish" : "Publish environment"}
        </Text>
      </Pressable>
    </View>
  );
}
