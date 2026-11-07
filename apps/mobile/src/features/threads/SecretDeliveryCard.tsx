import {
  createSecretDeliveryReveal,
  SECRET_DELIVERY_PRIVACY_NOTE,
  secretDeliveryDisplay,
  secretDeliveryInput,
  type SecretDeliveryItem,
} from "@t3tools/client-runtime/secret-delivery";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useAppActive } from "../../lib/appState";
import { useDeadlinePassed } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

/**
 * A secret an agent delivered. The value lives only in this card's reveal state and is
 * dropped on Hide, Delete, leaving the screen, unmount and the app leaving the foreground,
 * so the app switcher's snapshot never shows it.
 */
export function SecretDeliveryCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  const deadlinePassed = useDeadlinePassed(item.type === "secret_delivery" ? item.expiresAt : null);
  const canRetrieve = useAtomValue(
    serverEnvironment.readSecretDelivery.permissionAtom(props.environmentId),
  );
  if (item.type !== "secret_delivery") return null;
  const display = secretDeliveryDisplay(item, { visibility, deadlinePassed, canRetrieve });
  if (display.kind === "unavailable") {
    return <SecretDeliveryRow item={item} label={display.label} iconColor={props.iconColor} />;
  }
  return (
    <AvailableSecretDelivery
      key={`${props.environmentId}:${item.id}`}
      environmentId={props.environmentId}
      item={item}
      iconColor={props.iconColor}
    />
  );
}

function SecretDeliveryRow(props: {
  readonly item: SecretDeliveryItem;
  readonly label: string;
  readonly iconColor: ColorValue;
}) {
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={LOCK_SYMBOL} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {props.item.label} · {props.label}
      </Text>
    </View>
  );
}

async function writeSecretToClipboard(value: Promise<string>): Promise<boolean> {
  return tryCopyTextWithHaptic(await value, { target: "secret" });
}

function AvailableSecretDelivery(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretDeliveryItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const commandOptions = { reportFailure: false, reportDefect: false } as const;
  // The read's success holds the value and its failure may echo it; keep both out of the console.
  const read = useAtomCommand(serverEnvironment.readSecretDelivery, {
    label: "read secret delivery",
    ...commandOptions,
  });
  const remove = useAtomCommand(serverEnvironment.deleteSecretDelivery, {
    label: "delete secret delivery",
    ...commandOptions,
  });
  const canDelete = useAtomValue(
    serverEnvironment.deleteSecretDelivery.permissionAtom(props.environmentId),
  );
  const [reveal] = useState(() =>
    createSecretDeliveryReveal({
      read: () => read({ environmentId: props.environmentId, input: secretDeliveryInput(item) }),
      delete: () =>
        remove({ environmentId: props.environmentId, input: secretDeliveryInput(item) }),
    }),
  );
  const state = useSyncExternalStore(reveal.subscribe, reveal.getState, reveal.getState);
  const appActive = useAppActive();
  const focused = useIsFocused();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the value when the app leaves the foreground, the screen loses focus, or the card unmounts
  useEffect(() => {
    if (!appActive || !focused) reveal.hide();
    return reveal.hide;
  }, [appActive, focused, reveal]);

  if (state.deleted) {
    return <SecretDeliveryRow item={item} label="Deleted" iconColor={props.iconColor} />;
  }

  const busy = state.pending !== null;
  const confirmDelete = () =>
    Dialog.confirm({
      title: `Delete "${item.label}"?`,
      message: "T3 removes its copy. Anything already copied stays where it is.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => void reveal.delete(),
    });

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
      {state.value === null ? (
        <Text
          className="font-mono text-sm text-foreground-muted"
          accessibilityLabel="Hidden"
          importantForAccessibility="yes"
        >
          ••••••••••••
        </Text>
      ) : (
        <Text className="font-mono text-sm leading-5 text-foreground" selectable>
          {state.value}
        </Text>
      )}
      {state.error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {state.error}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            label={state.value === null ? "Reveal" : "Hide"}
            fullWidth
            disabled={state.value === null && busy}
            loading={state.pending === "reveal"}
            onPress={() => (state.value === null ? void reveal.reveal() : reveal.hide())}
          />
        </View>
        <View className="flex-1">
          <Button
            label={state.copied ? "Copied" : "Copy"}
            fullWidth
            disabled={busy}
            loading={state.pending === "copy"}
            onPress={() => void reveal.copy(writeSecretToClipboard)}
          />
        </View>
      </View>
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {SECRET_DELIVERY_PRIVACY_NOTE}
          </Text>
        </View>
        <Button label="Delete" tone="text" disabled={!canDelete || busy} onPress={confirmDelete} />
      </View>
    </View>
  );
}
