import { translate } from "@t3tools/i18n";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useTranslation } from "@t3tools/i18n/react";
import { type ReactNode, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ControlPillMenu } from "../../components/ControlPill";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? translate("common:mobileT3Connect.linkDateUnavailable", "Link date unavailable")
    : translate("common:mobileT3Connect.linkedAt", "Linked {{date}}", {
        date: linkedAtFormatter.format(linkedAt),
      });
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? translate("common:mobileT3Connect.managedTunnel", "Managed tunnel")
    : translate("common:mobileT3Connect.activityPublishingOnly", "Activity publishing only");
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = translate("common:mobileT3Connect.deregisterTitle", "Deregister server?");
  const message = translate(
    "common:mobileT3Connect.deregisterDescription",
    "“{{environment}}” will be removed from this account. T3 Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.",
    { environment: environment.label },
  );
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: translate("common:mobileT3Connect.cancel", "Cancel"), style: "cancel" },
      {
        text: translate("common:mobileT3Connect.deregister", "Deregister"),
        style: "destructive",
        onPress: onConfirm,
      },
    ]);
    return;
  }
  showConfirmDialog({
    title,
    message,
    confirmText: translate("common:mobileT3Connect.deregister", "Deregister"),
    destructive: true,
    onConfirm,
  });
}

/**
 * The "T3 Connect" custom page inside Clerk's native user profile: every
 * environment registered to the signed-in account, with account-level
 * deregistration. Mirrors the web UserButton page; connections on this device
 * are managed in Settings instead.
 */
export function T3ConnectProfilePage() {
  const { t } = useTranslation();
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  // Deregistered rows stay in the cached list until the refresh lands, so hide
  // them by the linkedAt they had. A re-link produces a new linkedAt and shows again.
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error
        ? cause.message
        : translate(
            "common:mobileT3Connect.deregisterFallback",
            "Could not deregister the server.",
          );
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Alert.alert(
      translate("common:mobileT3Connect.couldNotDeregister", "Could not deregister server"),
      traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
      traceId
        ? [
            {
              text: translate("common:mobileT3Connect.copyTraceId", "Copy trace ID"),
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: translate("common:mobileT3Connect.ok", "OK"), style: "cancel" },
          ]
        : undefined,
    );
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);
  const errorTraceId = environmentsState.errorTraceId;

  return (
    <ScrollView
      className="flex-1 bg-clerk-page"
      contentContainerClassName="pb-8"
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={environmentsState.isPending && environmentsState.data !== null}
          onRefresh={environmentsState.refresh}
        />
      }
    >
      <ClerkSectionHeader>{t("registeredServers")}</ClerkSectionHeader>

      {environmentsState.error ? (
        <>
          <ClerkRow
            title={translate(
              "common:mobileCouldNotLoadT3ConnectEnvironments",
              "Could not load T3 Connect environments",
            )}
            subtitle={environmentsState.error}
          />
          {errorTraceId ? (
            <ClerkButtonRow
              label={translate("common:copyTraceIdLabel", "Copy trace ID")}
              onPress={() => {
                copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
              }}
            />
          ) : null}
        </>
      ) : isInitialLoad ? (
        <View className="flex-row items-center gap-3 px-6 py-4">
          <ActivityIndicator colorClassName={"accent-clerk-foreground-muted"} size="small" />
          <Text className="text-base text-clerk-foreground-muted">{t("loadingEnvironments")}</Text>
        </View>
      ) : environments.length > 0 ? (
        environments.map((environment) => (
          <ClerkRow
            key={environment.environmentId}
            title={environment.label}
            subtitle={`${linkedAtLabel(environment.linkedAt)} · ${endpointLabel(environment)}`}
            accessory={
              deregisteringEnvironmentId === environment.environmentId ? (
                <ActivityIndicator colorClassName={"accent-clerk-foreground-muted"} size="small" />
              ) : (
                <ControlPillMenu
                  actions={environmentMenuActions()}
                  isAnchoredToRight
                  onPressAction={() =>
                    confirmDeregister(environment, () => void handleDeregister(environment))
                  }
                >
                  <Pressable
                    accessibilityLabel={translate(
                      "common:mobileT3Connect.actionsForEnvironment",
                      "Actions for {{environment}}",
                      { environment: environment.label },
                    )}
                    accessibilityRole="button"
                    disabled={deregisteringEnvironmentId !== null}
                    className="size-[30px] items-center justify-center active:opacity-60 disabled:opacity-50"
                  >
                    <View className="rotate-90">
                      <SymbolView
                        name="ellipsis"
                        size={18}
                        tintColorClassName={"accent-clerk-foreground-muted"}
                        type="monochrome"
                      />
                    </View>
                  </Pressable>
                </ControlPillMenu>
              )
            }
          />
        ))
      ) : (
        <ClerkRow
          title={translate("common:mobileNoServersRegistered", "No servers registered")}
          subtitle={translate(
            "common:mobileConnectServerFromSettings",
            "Link a server from its local Settings to reach it through T3 Connect.",
          )}
        />
      )}

      <Text className="px-6 pt-6 text-xs leading-normal text-clerk-foreground-muted">
        {translate(
          "common:mobileConnectionsManagedInSettings",
          "Connections on this device are managed in Settings.",
        )}
      </Text>
    </ScrollView>
  );
}

function environmentMenuActions(): MenuAction[] {
  return [
    {
      id: "deregister",
      title: translate("common:mobileT3Connect.deregister", "Deregister"),
      image: "trash",
      attributes: { destructive: true },
    },
  ];
}

// Layout primitives that mirror clerk-ios ClerkKitUI's profile rows so a custom
// page reads as one of Clerk's own screens. System font on purpose: Clerk's
// native views do not use the app's DM Sans.

function ClerkSectionHeader(props: { readonly children: string }) {
  return (
    <Text className="min-h-4 border-b border-clerk-border px-6 pt-8 pb-4 text-xs font-medium tracking-[0.3px] text-clerk-foreground-muted uppercase">
      {props.children}
    </Text>
  );
}

function ClerkRow(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly accessory?: ReactNode;
}) {
  return (
    <View
      collapsable={false}
      className="flex-row items-center gap-3 border-b border-clerk-border px-6 py-4"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="min-h-[22px] text-base text-clerk-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="min-h-5 text-sm text-clerk-foreground-muted" numberOfLines={2}>
          {props.subtitle}
        </Text>
      </View>
      {props.accessory}
    </View>
  );
}

function ClerkButtonRow(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="border-b border-clerk-border px-6 py-4 active:opacity-60"
    >
      <Text className="text-base font-semibold text-clerk-foreground">{props.label}</Text>
    </Pressable>
  );
}
