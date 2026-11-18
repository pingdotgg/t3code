import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { m, type MessageResolver } from "../../i18n/messages";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string, resolve: MessageResolver): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? resolve(msg("Link date unavailable"))
    : resolve(msg("Linked {date}", { date: linkedAtFormatter.format(linkedAt) }));
}

function endpointLabel(
  environment: RelayClientEnvironmentRecord,
  resolve: MessageResolver,
): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? resolve(msg("Managed tunnel"))
    : environment.endpoint.providerKind === "t3_relay"
      ? resolve(msg("Carried by the relay"))
      : resolve(msg("Activity publishing only"));
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = m(msg("Deregister server?"));
  const message = m(
    msg(
      "“{environment}” will be removed from this account. {product} access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.",
      { environment: environment.label, product: "T3 Connect" },
    ),
  );
  Dialog.confirm({
    title,
    message,
    confirmText: m(msg("Deregister")),
    destructive: true,
    onConfirm,
  });
}

export function T3ConnectProfilePage() {
  const gt = useGT();
  const m = useMessages();
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refreshAfterMutation, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  // Hide cached rows by linkedAt until refresh; re-linking changes linkedAt and restores visibility.
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
      void refreshRelayEnvironments();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error
        ? (errorDisplayMessage(cause, m) ?? cause.message)
        : gt("Could not deregister the server.");
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Dialog.alert(
      gt("Could not deregister server"),
      traceId ? gt("{message}\n\nTrace ID: {traceId}", { message, traceId }) : message,
      traceId
        ? [
            {
              text: gt("Copy trace ID"),
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: gt("OK"), style: "cancel" },
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
  const environmentMenuActions = [
    {
      id: "deregister",
      title: gt("Deregister"),
      image: "trash",
      attributes: { destructive: true },
    },
  ] satisfies MenuAction[];

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
      <ClerkSectionHeader>{gt("Registered servers")}</ClerkSectionHeader>

      {environmentsState.error ? (
        <>
          <ClerkRow
            title={gt("Could not load {product} environments", { product: "T3 Connect" })}
            subtitle={environmentsState.error}
          />
          {errorTraceId ? (
            <ClerkButtonRow
              label={gt("Copy trace ID")}
              onPress={() => {
                copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
              }}
            />
          ) : null}
        </>
      ) : isInitialLoad ? (
        <View className="flex-row items-center gap-3 px-6 py-4">
          <AppActivityIndicator colorClassName={"accent-clerk-foreground-muted"} size="small" />
          <Text className="text-base text-clerk-foreground-muted">
            <T>Loading environments</T>
          </Text>
        </View>
      ) : environments.length > 0 ? (
        environments.map((environment) => (
          <ClerkRow
            key={environment.environmentId}
            title={environment.label}
            subtitle={`${linkedAtLabel(environment.linkedAt, m)} · ${endpointLabel(environment, m)}`}
            accessory={
              deregisteringEnvironmentId === environment.environmentId ? (
                <AppActivityIndicator
                  colorClassName={"accent-clerk-foreground-muted"}
                  size="small"
                />
              ) : (
                <Menu
                  actions={environmentMenuActions}
                  isAnchoredToRight
                  onPressAction={() =>
                    confirmDeregister(environment, () => void handleDeregister(environment))
                  }
                >
                  <Pressable
                    accessibilityLabel={gt("Actions for {environment}", {
                      environment: environment.label,
                    })}
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
                </Menu>
              )
            }
          />
        ))
      ) : (
        <ClerkRow
          title={gt("No servers registered")}
          subtitle={gt("Link a server from its local Settings to reach it through {product}.", {
            product: "T3 Connect",
          })}
        />
      )}

      <Text className="px-6 pt-6 text-xs leading-normal text-clerk-foreground-muted">
        <T>Connections on this device are managed in Settings.</T>
      </Text>
    </ScrollView>
  );
}

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
