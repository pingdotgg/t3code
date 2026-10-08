import { useAtomValue } from "@effect/atom-react";
import {
  type LinkableMachine,
  linkRequestAnswerInput,
  linkRequestDefaultAccess,
  linkRequestDisplay,
  linkRequestFailureMessage,
  linkRequestInitialMachine,
  type LinkRequestItem,
  linkRequestTargetName,
  rankMachinesByHint,
} from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { useLinkableMachines } from "../../state/peerLinks";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { RequestActionButton } from "./RequestActionButton";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";

/** The same five levels as web's access picker: read-only, then the runtime modes. */
const ACCESS_CHOICES: ReadonlyArray<{
  readonly access: AuthMcpClientAccess;
  readonly label: string;
  readonly description: string;
}> = [
  {
    access: "read-only",
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
  },
  ...RUNTIME_MODE_CHOICES.map((choice) => ({ ...choice, access: choice.mode })),
];
const accessLabel = (access: AuthMcpClientAccess) =>
  ACCESS_CHOICES.find((choice) => choice.access === access)?.label ?? access;

const LINK_SYMBOL: AppSymbolName = { ios: "link", android: "desktop_windows" };

/** The machine list's row for linking by an address typed in. */
const ANOTHER_ADDRESS = "another-address";

/** Whether the agent left the machine for the user to pick. */
const picksMachine = (item: LinkRequestItem) =>
  item.environmentId === undefined && item.url === undefined;

/**
 * Feed card for a link an agent asked the user to make. The user picks the
 * access in a sheet; the pairing code lives only in that sheet's state and
 * the RPC payload, and is never logged, alerted, or persisted.
 */
export function LinkRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "link_request") return null;
  const display = linkRequestDisplay(item, visibility, accessLabel);
  if (display.kind === "pending") {
    return <PendingLinkRequest environmentId={props.environmentId} item={item} />;
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LINK_SYMBOL
      : display.outcome === "linked"
        ? "checkmark"
        : display.outcome === "failed"
          ? "xmark"
          : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {display.label}
      </Text>
    </View>
  );
}

function PendingLinkRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
}) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = useAtomCommand(serverEnvironment.answerLinkRequest, {
    label: "decline link request",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerLinkRequest.permissionAtom(props.environmentId),
  );
  const target = linkRequestTargetName(item);

  const decline = async () => {
    const input = linkRequestAnswerInput(item, { type: "decline" });
    if (input === null) return;
    setDeclining(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() =>
      setDeclining(false),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(linkRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          {picksMachine(item)
            ? "Link a machine to this environment"
            : `Link ${target} to this environment`}
        </Text>
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
        {item.label !== undefined && item.url !== undefined ? (
          <Text className="font-sans text-xs text-foreground-muted" numberOfLines={1}>
            {item.url}
          </Text>
        ) : null}
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      {canAnswer ? (
        <>
          <RequestActionButton
            label={picksMachine(item) ? "Choose machine…" : "Review link…"}
            disabled={declining}
            onPress={() => setOpen(true)}
          />
          <View className="flex-row justify-end">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: declining }}
              disabled={declining}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => void decline()}
            >
              <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">
          Only a session that manages access here can answer this.
        </Text>
      )}
      {open ? (
        <LinkRequestSheet
          environmentId={props.environmentId}
          item={item}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** What the sheet links; see web's LinkRequestDialog for the same rules. */
type SheetTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "machine";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly urls: ReadonlyArray<string>;
      readonly linked: boolean;
    }
  | { readonly kind: "address" };

function resolveTarget(
  item: LinkRequestItem,
  machines: ReadonlyArray<LinkableMachine>,
  choice: string | null,
): SheetTarget {
  if (item.environmentId === undefined && item.url !== undefined) return { kind: "address" };
  const chosen = item.environmentId ?? choice;
  if (chosen === null) return { kind: "none" };
  if (chosen === ANOTHER_ADDRESS) return { kind: "address" };
  const machine = machines.find((candidate) => candidate.environmentId === chosen);
  return {
    kind: "machine",
    environmentId: machine?.environmentId ?? (chosen as EnvironmentId),
    label: machine?.label ?? linkRequestTargetName(item),
    urls: [...new Set([...(machine?.urls ?? []), ...(item.url === undefined ? [] : [item.url])])],
    linked: machine?.linked ?? false,
  };
}

function LinkRequestSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem;
  readonly onClose: () => void;
}) {
  const { item } = props;
  const insets = useSafeAreaInsets();
  const pickMachine = picksMachine(item);
  const listed = useLinkableMachines(props.environmentId, true);
  const machines = useMemo(() => rankMachinesByHint(listed, item.hint), [listed, item.hint]);
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState(item.url ?? "");
  const [access, setAccess] = useState<AuthMcpClientAccess>(() => linkRequestDefaultAccess(item));
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const answer = useAtomCommand(serverEnvironment.answerLinkRequest, {
    label: "answer link request",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const selected = choice ?? linkRequestInitialMachine(item, machines);
  const target = resolveTarget(item, machines, selected);
  const targetName = target.kind === "machine" ? target.label : linkRequestTargetName(item);
  // This phone can mint a code there when it is connected to that environment
  // with a session that may create pairing links.
  const targetId = target.kind === "machine" ? target.environmentId : null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  const canMint =
    targetId !== null && Option.isSome(connected) && mayMint && !mintFailed.has(targetId);
  const needsAddress =
    target.kind === "address" || (target.kind === "machine" && target.urls.length === 0);
  const useExisting = target.kind === "machine" && target.linked;
  const ready =
    target.kind !== "none" &&
    (useExisting ||
      ((!needsAddress || address.trim().length > 0) && (canMint || pairingCode.trim().length > 0)));

  const submit = async () => {
    if (inFlight.current || target.kind === "none") return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let input;
      if (target.kind === "machine" && target.linked) {
        input = linkRequestAnswerInput(item, {
          type: "use-existing",
          environmentId: target.environmentId,
        });
      } else {
        let code = pairingCode;
        if (canMint && targetId !== null) {
          try {
            code = await mintPairingCodeOn(targetId);
          } catch (cause) {
            setMintFailed((failed) => new Set(failed).add(targetId));
            setError(linkRequestFailureMessage(cause));
            return;
          }
        }
        input = linkRequestAnswerInput(item, {
          type: "link",
          target:
            target.kind === "address"
              ? { url: address }
              : { ...target, urls: needsAddress ? [address.trim()] : target.urls },
          access,
          pairingCode: code,
        });
      }
      if (input === null) return;
      const result = await answer({ environmentId: props.environmentId, input });
      if (result._tag === "Success") {
        setPairingCode("");
        props.onClose();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        setError(linkRequestFailureMessage(squashAtomCommandFailure(result)));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
      onRequestClose={props.onClose}
    >
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-1">
          <Text className="font-t3-bold text-lg text-foreground">
            {pickMachine ? "Link a machine" : `Link ${targetName}`}
          </Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            Agents here can then launch, message and wait on threads there. It appears in that
            machine's Connections, where it can be revoked.
          </Text>
          {!pickMachine && item.url !== undefined ? (
            <Text className="font-sans text-xs text-foreground-muted" numberOfLines={1}>
              {item.url}
            </Text>
          ) : null}
        </View>
        {pickMachine ? (
          <SettingsSection title="Machine">
            {machines.map((machine, index) => (
              <MachineRow
                key={machine.environmentId}
                machine={machine}
                selected={selected === machine.environmentId}
                separated={index > 0}
                disabled={busy}
                onPress={() => {
                  setChoice(machine.environmentId);
                  setError(null);
                }}
              />
            ))}
            <SettingsChoiceRow
              label="Another address…"
              description="Link a machine this app does not know, by its https or Tailscale address."
              selected={selected === ANOTHER_ADDRESS}
              separated={machines.length > 0}
              disabled={busy}
              onPress={() => {
                setChoice(ANOTHER_ADDRESS);
                setError(null);
              }}
            />
          </SettingsSection>
        ) : null}
        {needsAddress && !(item.url !== undefined && item.environmentId === undefined) ? (
          <View className="gap-2">
            <TextInput
              accessibilityLabel="Address"
              placeholder="https://machine.tailnet.ts.net"
              value={address}
              onChangeText={setAddress}
              editable={!busy}
              autoCorrect={false}
              autoCapitalize="none"
              keyboardType="url"
              spellCheck={false}
            />
            {target.kind === "machine" ? (
              <Text className="font-sans text-xs text-foreground-muted">
                This app reaches {target.label} only through T3 Connect or SSH. Enter its https or
                Tailscale address.
              </Text>
            ) : null}
          </View>
        ) : null}
        {useExisting ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            This environment is already linked to {targetName}. The agent can use that link as it
            is; change its access in Settings → Connections.
          </Text>
        ) : target.kind === "none" ? null : (
          <>
            {canMint ? null : (
              <View className="gap-2">
                <TextInput
                  accessibilityLabel="Pairing code"
                  placeholder="Paste the code"
                  value={pairingCode}
                  onChangeText={setPairingCode}
                  editable={!busy}
                  autoCorrect={false}
                  autoCapitalize="none"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  spellCheck={false}
                />
                <Text className="font-sans text-xs text-foreground-muted">
                  Create a link on {targetName}: Settings → Connections → Create link, then paste
                  its code here.
                </Text>
              </View>
            )}
            <SettingsSection title="What agents here may do there">
              {ACCESS_CHOICES.map((choice, index) => (
                <SettingsChoiceRow
                  key={choice.access}
                  label={choice.label}
                  description={choice.description}
                  selected={choice.access === access}
                  separated={index > 0}
                  disabled={busy}
                  onPress={() => setAccess(choice.access)}
                />
              ))}
            </SettingsSection>
            <Text className="font-sans text-xs text-foreground-muted">
              An agent here never gets more there than its own mode here either. Threads it starts
              there cannot change that environment's own threads, projects or settings.
            </Text>
          </>
        )}
        {error !== null ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="font-sans text-sm text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        <RequestActionButton
          label={busy ? "Linking…" : useExisting ? "Use this link" : "Link"}
          size="large"
          disabled={busy || !ready}
          onPress={() => void submit()}
        />
        <RequestActionButton
          label="Cancel"
          tone="secondary"
          disabled={busy}
          onPress={props.onClose}
        />
      </ScrollView>
    </Modal>
  );
}

/** One machine in the sheet's list: its glyph, name, and whether it is linked or reachable. */
function MachineRow(props: {
  readonly machine: LinkableMachine;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { machine } = props;
  const status = machine.linked ? "Linked" : machine.connected ? null : "Not connected";
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70"
          : "flex-row items-center gap-3 p-4 active:opacity-70"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <EnvironmentMachineSymbol
        kind={machine.machine}
        size={18}
        tintColorClassName="accent-foreground-muted"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>
          {machine.label}
        </Text>
        {status === null ? null : <Text className="text-sm text-foreground-muted">{status}</Text>}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
