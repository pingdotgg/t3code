import { useAtomValue } from "@effect/atom-react";
import {
  linkBatchBlockLabel,
  linkBatchCandidates,
  linkBatchFailureLabel,
  type LinkBatchOutcome,
  linkBatchSummary,
  linkListState,
  runLinkBatch,
} from "@t3tools/client-runtime/link-batch";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { T, useGT, useMessages } from "gt-react-native";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Sheet } from "../../components/ui/Sheet";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment, useLinkableMachines } from "../../state/peerLinks";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { LINK_ACCESS_CHOICES } from "../threads/LinkRequestCard";

const NO_MACHINES: ReadonlySet<EnvironmentId> = new Set();
const NO_OUTCOMES: ReadonlyMap<EnvironmentId, LinkBatchOutcome> = new Map();

/** Offers a batch link from `environmentId` once this app has two other machines saved. */
export function LinkSeveralEnvironmentsAction(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const config = useEnvironmentServerConfig(props.environmentId);
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(props.environmentId));
  const otherMachines = useEnvironments().environments.length - 1;
  if (!canLink || !offersLinkedEnvironments(config) || otherMachines < 2) return null;
  return (
    <View className="mt-3">
      <Button
        label={gt("Link several machines to {environment}…", {
          environment: props.environmentLabel,
        })}
        onPress={() => setOpen(true)}
        fullWidth
      />
      {open ? (
        <LinkSeveralSheet environmentId={props.environmentId} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
}

/**
 * Each pairing code is minted on its machine and passed straight to the linking
 * environment; none is ever held in state, shown, or logged.
 */
function LinkSeveralSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const machines = useLinkableMachines(props.environmentId, true);
  // The same shared list `useLinkableMachines` reads `linked` from.
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const linksState = linkListState(links);
  const machineIds = machines.map((machine) => machine.environmentId).join("\n");
  const scoped = useMemo(
    () =>
      machineIds
        .split("\n")
        .filter((id) => id.length > 0)
        .map((id) => ({ environmentId: id as EnvironmentId })),
    [machineIds],
  );
  const writable = useEnvironmentsWithScope(scoped, AuthAccessWriteScope);
  const [selected, setSelected] = useState(NO_MACHINES);
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const [linking, setLinking] = useState(NO_MACHINES);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const link = useAtomCommand(peerLinkEnvironment.linkInBatch, {
    label: "link several environments",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const candidates = linkBatchCandidates(machines, writable, linksState);
  const selectable = candidates.flatMap(({ machine, blocked }) =>
    blocked === null && outcomes.get(machine.environmentId)?.kind !== "linked" ? [machine] : [],
  );
  const chosen = selectable.filter((machine) => selected.has(machine.environmentId));
  const busy = linking.size > 0;
  const summary = linkBatchSummary(outcomes);
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  const toggle = (id: EnvironmentId) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const submit = async () => {
    if (inFlight.current || chosen.length === 0) return;
    inFlight.current = true;
    setLinking(new Set(chosen.map((machine) => machine.environmentId)));
    const results = await runLinkBatch({
      machines: chosen,
      access,
      mint: mintPairingCodeOn,
      link: async (input) => {
        const result = await link({ environmentId: props.environmentId, input });
        return result._tag === "Success"
          ? Result.succeed(result.value)
          : Result.fail(squashAtomCommandFailure(result));
      },
      refreshLinks: links.refresh,
      onOutcome: (id, outcome) => {
        setOutcomes((current) => new Map(current).set(id, outcome));
        setLinking((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      },
    });
    inFlight.current = false;
    setLinking(NO_MACHINES);
    // What failed stays picked, so linking again retries only those.
    setSelected(new Set(linkBatchSummary(results).failed));
  };

  return (
    <Sheet
      title={gt("Link several environments")}
      onClose={props.onClose}
      // A batch that lands after a close would still link.
      dismissDisabled={busy}
    >
      <ScrollView
        nestedScrollEnabled
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          <T>
            Agents here can then launch, message and wait on threads on each machine you pick. Each
            appears under Authorized clients in that machine's Sharing & access, where it can be
            revoked.
          </T>
        </Text>
        {candidates.length === 0 ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            <T>This app knows no other machines. Add them under Environments first.</T>
          </Text>
        ) : (
          <>
            {linksState === "loading" ? (
              <Text
                accessibilityLiveRegion="polite"
                className="font-sans text-sm leading-5 text-foreground-muted"
              >
                <T>Checking which machines are already linked…</T>
              </Text>
            ) : linksState === "failed" ? (
              <View className="gap-2">
                <Text
                  accessibilityLiveRegion="polite"
                  className="font-sans text-sm leading-5 text-danger-foreground"
                >
                  {gt(
                    "Could not check which machines are already linked, so none can be picked: {error}",
                    { error: links.error ?? "" },
                  )}
                </Text>
                <Button
                  label={gt("Retry")}
                  size="compact"
                  disabled={links.isPending}
                  onPress={links.refresh}
                />
              </View>
            ) : null}
            <SettingsSection title={gt("Machines")}>
              {candidates.map(({ machine, blocked }, index) => {
                const id = machine.environmentId;
                const outcome = outcomes.get(id);
                const available = blocked === null && outcome?.kind !== "linked";
                const checked = available && selected.has(id);
                const status = linking.has(id)
                  ? gt("Linking…")
                  : outcome?.kind === "linked"
                    ? gt("Linked", { $context: "status of a machine that was just linked" })
                    : outcome?.kind === "failed"
                      ? `${linkBatchFailureLabel(outcome.failure, m)}${outcome.detail === null ? "" : `: ${outcome.detail}`}`
                      : blocked === null
                        ? null
                        : linkBatchBlockLabel(blocked, m);
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="checkbox"
                    accessibilityLabel={machine.label}
                    accessibilityHint={status ?? undefined}
                    accessibilityState={{ checked, disabled: busy || !available }}
                    className={
                      index > 0
                        ? "flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70"
                        : "flex-row items-center gap-3 p-4 active:opacity-70"
                    }
                    disabled={busy || !available}
                    onPress={() => toggle(id)}
                  >
                    <EnvironmentMachineSymbol
                      kind={machine.machine}
                      size={18}
                      tintColorClassName="accent-foreground-muted"
                    />
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className={
                          available
                            ? "text-lg text-foreground android:text-base"
                            : "text-lg text-foreground-muted android:text-base"
                        }
                        numberOfLines={1}
                      >
                        {machine.label}
                      </Text>
                      {status === null ? null : (
                        <Text
                          className={
                            outcome?.kind === "failed"
                              ? "text-sm text-danger-foreground"
                              : "text-sm text-foreground-muted"
                          }
                        >
                          {status}
                        </Text>
                      )}
                    </View>
                    {checked ? (
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
              })}
            </SettingsSection>
            <Button
              label={allChosen ? gt("Select none") : gt("Select all")}
              tone="text"
              size="compact"
              disabled={busy || selectable.length === 0}
              onPress={() =>
                setSelected(
                  allChosen
                    ? NO_MACHINES
                    : new Set(selectable.map((machine) => machine.environmentId)),
                )
              }
            />
          </>
        )}
        <SettingsSection title={gt("What agents here may do there")}>
          {LINK_ACCESS_CHOICES.map((choice, index) => (
            <ListChoiceRow
              key={choice.access}
              label={m(choice.label)}
              description={m(choice.description)}
              selected={choice.access === access}
              separated={index > 0}
              disabled={busy}
              onPress={() => setAccess(choice.access)}
            />
          ))}
        </SettingsSection>
        {outcomes.size > 0 && !busy ? (
          <Text
            accessibilityLiveRegion="polite"
            className="font-sans text-sm leading-5 text-foreground-muted"
          >
            {summary.failed.length === 0
              ? gt("{linked, plural, one {Linked # machine.} other {Linked # machines.}}", {
                  linked: summary.linked,
                })
              : gt(
                  "Linked {linked} of {total}. The ones that failed stay selected, so you can try them again.",
                  { linked: summary.linked, total: outcomes.size },
                )}
          </Text>
        ) : null}
        <Button
          label={
            busy
              ? gt("Linking…")
              : gt("{count, plural, one {Link # machine} other {Link # machines}}", {
                  count: chosen.length,
                })
          }
          disabled={busy || chosen.length === 0}
          onPress={() => void submit()}
          tone="primary"
          fullWidth
        />
        <Button
          label={outcomes.size > 0 ? gt("Done") : gt("Cancel")}
          tone="secondary"
          disabled={busy}
          onPress={props.onClose}
          fullWidth
        />
      </ScrollView>
    </Sheet>
  );
}
