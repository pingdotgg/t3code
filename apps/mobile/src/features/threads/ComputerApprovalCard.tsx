import {
  computerActionSentence,
  computerApprovalSurface,
  computerApprovalTypedText,
} from "@t3tools/client-runtime/state/computer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerApproval, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { useDeadlinePassed } from "../../lib/clock";
import { computerEnvironment, useCanApproveComputerSteps } from "../../state/computer";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export interface ComputerApprovalCardProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly approval: ComputerApproval;
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-0.5">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-muted">
        {props.label}
      </Text>
      {props.children}
    </View>
  );
}

/** Seconds left, ticking on the shared second clock so only this line re-renders. */
function ApprovalCountdown(props: { readonly expiresAtMs: number; readonly running: boolean }) {
  const nowMs = useVisibleSecondClock(props.running);
  const seconds = Math.max(0, Math.ceil((props.expiresAtMs - nowMs) / 1000));
  return (
    <Text className="shrink-0 font-sans text-xs tabular-nums text-foreground-muted">
      {seconds <= 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
    </Text>
  );
}

/**
 * One consequential computer step, waiting for a person's tap: what it does, the exact text it
 * types, where, why, the goal it serves, and how long it lasts. Screen text is data, so it is
 * shown, never acted on.
 */
export function ComputerApprovalCard(props: ComputerApprovalCardProps) {
  const { approval, environmentId } = props;
  const expiresAtMs = DateTime.toEpochMillis(approval.expiresAt);
  const expired = useDeadlinePassed(expiresAtMs);
  const canApprove = useCanApproveComputerSteps(environmentId);
  const respond = useAtomCommand(computerEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    if (!canApprove || responding !== null || expired) return;
    setResponding(approve);
    setError(null);
    const result = await respond({
      environmentId,
      input: { approvalId: approval.id, approve },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not answer that step.");
    }
    setResponding(null);
  };

  const disabled = !canApprove || responding !== null || expired;
  const typedText = computerApprovalTypedText(approval);
  const surface = computerApprovalSurface(approval);

  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-2.5 rounded-[20px] border border-warning-border bg-warning p-4"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-start gap-2">
          <SymbolView
            name="exclamationmark.shield"
            size={15}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 font-t3-bold text-base text-warning-foreground">
            {computerActionSentence(approval.binding.action)}
          </Text>
        </View>
        {expired ? (
          <Text className="shrink-0 font-sans text-xs text-foreground-muted">Expired</Text>
        ) : (
          <ApprovalCountdown expiresAtMs={expiresAtMs} running={!expired} />
        )}
      </View>
      <Text className="font-sans text-sm leading-5 text-foreground-secondary">
        {approval.binding.why}
      </Text>
      <View className="gap-2">
        {surface.length === 0 ? null : (
          <Field label="On">
            <Text className="font-mono text-xs text-foreground">{surface}</Text>
          </Field>
        )}
        <Field label="Goal">
          <Text className="font-sans text-sm text-foreground">{approval.binding.goal}</Text>
        </Field>
        <Field label="Asked by">
          <Text className="font-sans text-sm text-foreground">
            {approval.binding.requester} · {props.environmentLabel}
          </Text>
        </Field>
      </View>
      {typedText === null ? null : (
        <Field label="Will type">
          <ScrollView
            className="mt-1 rounded-xl border border-border/60 bg-subtle"
            contentContainerClassName="p-3"
            style={{ maxHeight: 160 }}
            nestedScrollEnabled
          >
            <Text selectable className="font-mono text-xs text-foreground">
              {typedText}
            </Text>
          </ScrollView>
        </Field>
      )}
      <View className="mt-1 flex-row items-center gap-2">
        <View className="flex-1">
          <Button
            label={responding === false ? "Denying…" : "Deny"}
            tone="danger"
            fullWidth
            disabled={disabled}
            onPress={() => void decide(false)}
          />
        </View>
        <View className="flex-1">
          <Button
            label={responding === true ? "Approving…" : "Approve"}
            tone="primary"
            fullWidth
            disabled={disabled}
            onPress={() => void decide(true)}
          />
        </View>
      </View>
      {canApprove ? null : (
        <Text className="font-sans text-xs leading-normal text-foreground-muted">
          This connection cannot approve computer steps. Pair this device again in Settings →
          Environments.
        </Text>
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
    </View>
  );
}
