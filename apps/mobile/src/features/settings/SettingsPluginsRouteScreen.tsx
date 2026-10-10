import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  type EnvironmentId,
  type PluginInstallation,
  type PluginInstallationId,
  type PluginNpmPackage,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  describePluginNpmSource,
  PLUGIN_NPM_INTEGRITY_STATEMENT,
  pluginNpmListKey,
  pluginNpmRowLabel,
  resolvePluginNpmPackagesState,
  resolvePluginNpmProvenance,
  supportsPluginNpm,
} from "@t3tools/client-runtime/state/pluginNpmPresentation";
import {
  describePluginSource,
  presentPluginInstallation,
  resolvePluginCatalogState,
  resolvePluginDetail,
  type PluginStateTone,
} from "@t3tools/client-runtime/state/pluginPresentation";
import { useEffect, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { pluginEnvironment, pluginNpmEnvironment } from "../../state/plugins";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type PluginRoutes = {
  SettingsPlugin: {
    readonly environmentId: EnvironmentId;
    readonly installationId: PluginInstallationId;
  };
};

const TONE_TEXT: Record<PluginStateTone, string> = {
  neutral: "text-foreground-muted",
  success: "text-foreground",
  info: "text-foreground",
  warning: "text-warning-foreground",
  error: "text-danger-foreground",
};

/** Whether this environment's server has the plugin catalogue; older servers never get a plugin call. */
export function supportsPlugins(target: SettingsTarget): boolean {
  return target.serverConfig.environment.capabilities.plugins === true;
}

/**
 * Mobile always pairs with standard scopes, so it never has the access:write that
 * plugin management needs; it shows plugins without controls.
 */
const PLUGINS_VIEW_ONLY =
  "Plugins are view-only on mobile. Add, install, approve, enable, update, or remove them from an administrative web or desktop connection.";

function ViewOnlyNotice() {
  return <Text className="px-2 text-sm text-foreground-muted">{PLUGINS_VIEW_ONLY}</Text>;
}

/** The catalogue of a connected environment that supports plugins; anything else gets no call. */
function usePluginCatalog(environmentId: EnvironmentId, environment: SettingsTarget | undefined) {
  const supported = environment !== undefined && supportsPlugins(environment);
  const catalog = useEnvironmentQuery(
    supported ? pluginEnvironment.catalog({ environmentId, input: {} }) : null,
  );
  const state = resolvePluginCatalogState({
    connected: environment !== undefined,
    data: supported ? catalog.data : { _tag: "unsupported" },
    error: catalog.error,
  });
  return { state, retry: catalog.refresh };
}

/** Calls `refresh` when `key` changes from one known value to another; never on a timer. */
function useRefreshOnChange(key: string | null, refresh: () => void) {
  const last = useRef(key);
  useEffect(() => {
    const previous = last.current;
    last.current = key;
    if (previous !== null && key !== null && previous !== key) refresh();
  }, [key, refresh]);
}

/**
 * Where an environment's plugins came from on npm. An older server gets no call.
 * The list is a query, so it is read again when installations or their files change.
 */
function usePluginNpmPackages(
  environmentId: EnvironmentId,
  environment: SettingsTarget | undefined,
  installations: ReadonlyArray<PluginInstallation> | null,
) {
  const supported =
    environment !== undefined &&
    supportsPluginNpm(environment.serverConfig.environment.capabilities);
  const query = useEnvironmentQuery(
    supported ? pluginNpmEnvironment.packages({ environmentId, input: {} }) : null,
  );
  useRefreshOnChange(
    supported && installations !== null ? pluginNpmListKey(installations) : null,
    query.refresh,
  );
  return {
    state: resolvePluginNpmPackagesState({ supported, data: query.data, error: query.error }),
    refresh: query.refresh,
  };
}

const SCROLL_PROPS = {
  keyboardShouldPersistTaps: "handled",
  contentInsetAdjustmentBehavior: "automatic",
  showsVerticalScrollIndicator: false,
  className: "flex-1",
  contentContainerClassName: "gap-5 px-5 pt-4",
} as const;

export function SettingsPluginsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const targets = selectedTargets.filter(supportsPlugins);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Plugins" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          {...SCROLL_PROPS}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length > 0 ? (
            targets.map((target) => (
              <EnvironmentPlugins key={target.environmentId} environment={target} />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to see its plugins."
                : selectedTargets.length === 0
                  ? "Select an environment to see its plugins."
                  : "Update T3 Code on the selected environments to see their plugins."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentPlugins({ environment }: { readonly environment: SettingsTarget }) {
  const navigation = useNavigation<NativeStackNavigationProp<PluginRoutes>>();
  const environmentId = environment.environmentId;
  const catalog = usePluginCatalog(environmentId, environment);
  const installations =
    catalog.state._tag === "available" ? catalog.state.view.installations : null;
  const npm = usePluginNpmPackages(environmentId, environment, installations);
  if (catalog.state._tag === "unsupported") return null;
  return (
    <View className="gap-2">
      <SettingsSection
        title={environment.label}
        titleIcon={
          <EnvironmentMachineSymbol
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            size={16}
            tintColorClassName={
              Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
            }
          />
        }
      >
        {catalog.state._tag === "failed" ? (
          <>
            <Text className="p-4 text-base text-danger-foreground">{catalog.state.message}</Text>
            <View className="border-t border-border-subtle">
              <SettingsActionRow icon="arrow.clockwise" label="Retry" onPress={catalog.retry} />
            </View>
          </>
        ) : installations === null ? (
          <Text className="p-4 text-base text-foreground-muted">Loading plugins…</Text>
        ) : installations.length === 0 ? (
          <Text className="p-4 text-base text-foreground-muted">No plugins yet.</Text>
        ) : (
          installations.map((installation, index) => (
            <PluginListRow
              key={installation.installationId}
              installation={installation}
              npmPackage={npmPackageOf(npm.state, installation.installationId)}
              first={index === 0}
              onPress={() =>
                navigation.navigate("SettingsPlugin", {
                  environmentId,
                  installationId: installation.installationId,
                })
              }
            />
          ))
        )}
      </SettingsSection>
      {installations !== null ? <ViewOnlyNotice /> : null}
    </View>
  );
}

/** The npm package behind a listed installation, from the list alone. */
function npmPackageOf(
  state: ReturnType<typeof resolvePluginNpmPackagesState>,
  installationId: PluginInstallationId,
): PluginNpmPackage | null {
  const provenance = resolvePluginNpmProvenance({ state, installationId, step: null });
  return provenance._tag === "found" ? provenance.package : null;
}

function PluginListRow({
  installation,
  npmPackage,
  first,
  onPress,
}: {
  readonly installation: PluginInstallation;
  readonly npmPackage: PluginNpmPackage | null;
  readonly first: boolean;
  readonly onPress: () => void;
}) {
  const view = presentPluginInstallation(installation);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${view.title}, ${view.stateLabel}${view.delivery ? `, ${view.delivery.label}` : ""}`}
      onPress={onPress}
      className={
        first
          ? "flex-row items-center gap-3 px-4 py-4 active:opacity-70"
          : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-4 active:opacity-70"
      }
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
          {view.title}
          {installation.manifest ? (
            <Text className="text-sm text-foreground-muted"> {installation.manifest.version}</Text>
          ) : null}
        </Text>
        <Text className={`text-sm ${TONE_TEXT[view.tone]}`} numberOfLines={2}>
          {view.stateLabel}
          {view.detail ? ` · ${view.detail}` : ""}
        </Text>
        {view.delivery ? (
          <Text className={`text-sm ${TONE_TEXT[view.delivery.tone]}`} numberOfLines={2}>
            {view.delivery.label}
            {view.delivery.detail ? ` · ${view.delivery.detail}` : ""}
          </Text>
        ) : null}
        {npmPackage ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {pluginNpmRowLabel(npmPackage)}
          </Text>
        ) : null}
        <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {installation.directory}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" />
    </Pressable>
  );
}

function DetailField({
  label,
  value,
  mono = false,
  first = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly first?: boolean;
}) {
  return (
    <View className={first ? "gap-1 px-4 py-3" : "gap-1 border-t border-border-subtle px-4 py-3"}>
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <Text
        selectable
        className={mono ? "font-mono text-sm text-foreground" : "text-base text-foreground"}
      >
        {value}
      </Text>
    </View>
  );
}

export function SettingsPluginRouteScreen({
  route,
}: StaticScreenProps<PluginRoutes["SettingsPlugin"]>) {
  return (
    <PluginDetail
      key={`${route.params.environmentId}:${route.params.installationId}`}
      environmentId={route.params.environmentId}
      installationId={route.params.installationId}
    />
  );
}

function PluginDetail({
  environmentId,
  installationId,
}: {
  readonly environmentId: EnvironmentId;
  readonly installationId: PluginInstallationId;
}) {
  const insets = useSafeAreaInsets();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const environment = availableTargets.find((target) => target.environmentId === environmentId);
  const label = environment?.label ?? "this environment";
  const catalog = usePluginCatalog(environmentId, environment);
  const detail = resolvePluginDetail({ catalog: catalog.state, installationId, added: null });
  const npm = usePluginNpmPackages(
    environmentId,
    environment,
    catalog.state._tag === "available" ? catalog.state.view.installations : null,
  );

  if (detail._tag !== "found") {
    return (
      <SettingsScreen title="Plugin">
        <ScrollView {...SCROLL_PROPS}>
          {detail._tag === "failed" ? (
            <SettingsSection title="Could not load plugins">
              <Text selectable className="p-4 text-base text-danger-foreground">
                {detail.message}
              </Text>
              <View className="border-t border-border-subtle">
                <SettingsActionRow icon="arrow.clockwise" label="Retry" onPress={catalog.retry} />
              </View>
            </SettingsSection>
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {detail._tag === "missing"
                ? `This plugin is no longer installed on ${label}.`
                : detail._tag === "loading"
                  ? "Loading plugin…"
                  : detail._tag === "disconnected"
                    ? `Reconnect ${label} to see its plugins.`
                    : `${label} does not support plugins. Update T3 Code there.`}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    );
  }

  const installation = detail.installation;
  const view = presentPluginInstallation(installation);
  const manifest = installation.manifest;
  const digest = installation.source?.digest ?? null;
  const provenance = resolvePluginNpmProvenance({ state: npm.state, installationId, step: null });
  const npmPackage = provenance._tag === "found" ? provenance.package : null;

  return (
    <SettingsScreen title={view.title}>
      <ScrollView
        {...SCROLL_PROPS}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-1 px-2">
          <Text className={`text-base ${TONE_TEXT[view.tone]}`}>{view.stateLabel}</Text>
          {view.detail ? (
            <Text selectable className="text-sm text-foreground-muted">
              {view.detail}
            </Text>
          ) : null}
          {view.delivery ? (
            <>
              <Text className={`text-base ${TONE_TEXT[view.delivery.tone]}`}>
                {view.delivery.label}
              </Text>
              {view.delivery.detail ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {view.delivery.detail}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
        <SettingsSection title="Plugin">
          {manifest ? (
            <>
              <DetailField first label="Plugin ID" value={manifest.id} mono />
              <DetailField label="Version" value={manifest.version} />
              {manifest.description ? (
                <DetailField label="Description" value={manifest.description} />
              ) : null}
            </>
          ) : null}
          {npmPackage ? (
            <>
              <DetailField
                first={manifest === null}
                label="Package"
                value={describePluginNpmSource(npmPackage)}
              />
              <DetailField
                label="Integrity"
                value={`${npmPackage.source.integrity}\n${PLUGIN_NPM_INTEGRITY_STATEMENT}`}
                mono
              />
            </>
          ) : provenance._tag === "unknown" ? (
            <DetailField
              first={manifest === null}
              label="Package"
              value={
                npm.state._tag === "failed"
                  ? "Not known: where it came from did not load"
                  : "Checking where it came from…"
              }
            />
          ) : null}
          <DetailField
            first={manifest === null}
            label={`Directory on ${label}`}
            value={installation.directory}
            mono
          />
          <DetailField
            label="Files"
            value={installation.source ? describePluginSource(installation.source) : "Unreadable"}
          />
          {digest !== null ? <DetailField label="Digest" value={digest} mono /> : null}
          {manifest ? (
            <DetailField
              label="Capabilities"
              value={
                (manifest.capabilities.length === 0
                  ? "None declared"
                  : manifest.capabilities.join(", ")) +
                (manifest.proposedApi
                  ? "\nUses proposed APIs that may change between T3 Code versions."
                  : "")
              }
            />
          ) : null}
          {installation.problem ? (
            <DetailField label="Problem" value={installation.problem} />
          ) : null}
        </SettingsSection>
        {npm.state._tag === "failed" ? (
          <SettingsSection title="npm package">
            <Text selectable className="p-4 text-base text-danger-foreground">
              {npm.state.message}
            </Text>
            <View className="border-t border-border-subtle">
              <SettingsActionRow icon="arrow.clockwise" label="Retry" onPress={npm.refresh} />
            </View>
          </SettingsSection>
        ) : null}

        <ViewOnlyNotice />
      </ScrollView>
    </SettingsScreen>
  );
}
