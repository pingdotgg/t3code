import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
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

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { cn } from "../../lib/cn";
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
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = "Deregister server?";
  const message = `“${environment.label}” will be removed from this account. T3 Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.`;
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Deregister", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Deregister", destructive: true, onConfirm });
}

/**
 * The "T3 Connect" custom page inside Clerk's native user profile: every
 * environment registered to the signed-in account, with account-level
 * deregistration. Mirrors the web UserButton page; connections on this device
 * are managed in Settings instead.
 */
export function T3ConnectProfilePage() {
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
    const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Alert.alert(
      "Could not deregister server",
      traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
      traceId
        ? [
            {
              text: "Copy trace ID",
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: "OK", style: "cancel" },
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
      <ClerkSectionHeader>Registered servers</ClerkSectionHeader>

      {environmentsState.error ? (
        <ClerkSection>
          <View className="gap-1 px-6 py-4">
            <Text className="text-base leading-snug text-clerk-foreground">
              Could not load T3 Connect environments
            </Text>
            <Text className="text-sm leading-normal text-clerk-foreground-muted">
              {environmentsState.error}
            </Text>
          </View>
          {errorTraceId ? (
            <ClerkButtonRow
              label="Copy trace ID"
              onPress={() => {
                copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
              }}
            />
          ) : null}
        </ClerkSection>
      ) : isInitialLoad ? (
        <ClerkSection>
          <View className="flex-row items-center gap-3 px-6 py-4">
            <ActivityIndicator colorClassName={"accent-clerk-foreground-muted"} size="small" />
            <Text className="text-base text-clerk-foreground-muted">Loading environments</Text>
          </View>
        </ClerkSection>
      ) : environments.length > 0 ? (
        <ClerkSection>
          {environments.map((environment) => (
            <T3ConnectEnvironmentRow
              key={environment.environmentId}
              environment={environment}
              isDeregistering={deregisteringEnvironmentId === environment.environmentId}
              mutationPending={deregisteringEnvironmentId !== null}
              onDeregister={() =>
                confirmDeregister(environment, () => void handleDeregister(environment))
              }
            />
          ))}
        </ClerkSection>
      ) : (
        <ClerkSection>
          <View className="gap-1 px-6 py-4">
            <Text className="text-base leading-snug text-clerk-foreground">
              No servers registered
            </Text>
            <Text className="text-sm leading-normal text-clerk-foreground-muted">
              Link a server from its local Settings to reach it through T3 Connect.
            </Text>
          </View>
        </ClerkSection>
      )}

      <Text className="px-6 pt-4 text-xs leading-normal text-clerk-foreground-muted">
        Connections on this device are managed in Settings.
      </Text>
    </ScrollView>
  );
}

// Layout primitives that mirror clerk-ios ClerkKitUI's profile sections so a
// custom page reads as one of Clerk's own screens. System font on purpose:
// Clerk's native views do not use the app's DM Sans.

function ClerkSectionHeader(props: { readonly children: string }) {
  return (
    <Text className="min-h-4 border-b border-clerk-border px-6 pt-8 pb-4 text-xs font-medium tracking-[0.3px] text-clerk-foreground-muted uppercase">
      {props.children}
    </Text>
  );
}

function ClerkSection(props: { readonly children: ReactNode }) {
  return (
    <View collapsable={false} className="bg-clerk-surface">
      {props.children}
    </View>
  );
}

function ClerkButtonRow(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="flex-row items-center border-b border-clerk-border px-6 py-4 active:opacity-60 disabled:opacity-50"
    >
      <Text
        className={cn(
          "text-base font-semibold",
          props.destructive ? "text-clerk-danger" : "text-clerk-foreground",
        )}
      >
        {props.label}
      </Text>
      {props.pending ? (
        <ActivityIndicator
          className="ml-3"
          colorClassName={"accent-clerk-foreground-muted"}
          size="small"
        />
      ) : null}
    </Pressable>
  );
}

function T3ConnectEnvironmentRow(props: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly isDeregistering: boolean;
  readonly mutationPending: boolean;
  readonly onDeregister: () => void;
}) {
  const { environment } = props;
  return (
    <View collapsable={false}>
      <View className="gap-0.5 border-b border-clerk-border px-6 py-4">
        <Text className="min-h-[22px] text-base text-clerk-foreground" numberOfLines={1}>
          {environment.label}
        </Text>
        <Text className="min-h-5 text-sm text-clerk-foreground-muted" numberOfLines={1}>
          {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
        </Text>
      </View>
      <ClerkButtonRow
        destructive
        disabled={props.mutationPending}
        label="Deregister"
        onPress={props.onDeregister}
        pending={props.isDeregistering}
      />
    </View>
  );
}
