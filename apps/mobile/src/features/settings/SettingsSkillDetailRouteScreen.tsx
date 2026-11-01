import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SkillModelCell,
  SkillVariantMutateInput,
  SkillVariantRule,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { skillEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  formatSkillEffect,
  formatSkillInterval,
  hasSkillsCapability,
  ruleForSkillCell,
  skillDeliveryLabel,
  skillEffectiveModeLabel,
  skillGatingDescription,
  skillGatingLabel,
  skillObservationalSummary,
  skillRuleTargetLabel,
  skillVerdictLabel,
  skillVerdictReason,
  turnBackOnRuleForSkillCell,
} from "./skills-mobile";

function mutationErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function ModelCellSection({
  skillName,
  cell,
  rules,
  canMutate,
  pending,
  onMutate,
}: {
  readonly skillName: string;
  readonly cell: SkillModelCell;
  readonly rules: readonly SkillVariantRule[];
  readonly canMutate: boolean;
  readonly pending: string | null;
  readonly onMutate: (key: string, input: SkillVariantMutateInput) => void;
}) {
  const rule = ruleForSkillCell(cell, rules);
  const turnBackOnRule = turnBackOnRuleForSkillCell(cell, rules);
  const busy = pending !== null;
  const disabled = busy || !canMutate;
  const reason = skillVerdictReason(cell.verdict);
  const actionDescription = canMutate ? undefined : "Requires settings-write permission.";
  const ruleDescription = rule
    ? `${skillRuleTargetLabel(rule)} · revision ${rule.revision} · ${rule.enabled ? "enabled" : "disabled"}`
    : "No variant rule currently applies.";

  function confirmTurnOff() {
    Dialog.alert(
      `Turn off ${skillName}?`,
      `${cell.model} will be instructed not to use this skill. You can turn it back on here.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn off",
          style: "destructive",
          onPress: () =>
            onMutate(`off:${cell.driver}:${cell.model}`, {
              action: "set-off",
              skillName,
              driver: cell.driver,
              model: cell.model,
            }),
        },
      ],
    );
  }

  function confirmDelete(candidate: SkillVariantRule) {
    Dialog.alert(
      "Delete skill rule?",
      `${skillRuleTargetLabel(candidate)} will fall back to the next matching rule or the base skill. You can restore this rule later.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            onMutate(`delete:${candidate.ruleId}`, {
              action: "delete",
              ruleId: candidate.ruleId,
            }),
        },
      ],
    );
  }

  const actionRows = [
    ...(rule?.deletedAt === null && rule.mode === "variant"
      ? [
          <ListActionRow
            key="toggle"
            label={rule.enabled ? "Disable variant" : "Enable variant"}
            description={actionDescription ?? `Target: ${skillRuleTargetLabel(rule)}`}
            disabled={disabled}
            loading={pending === `toggle:${rule.ruleId}`}
            onPress={() =>
              onMutate(`toggle:${rule.ruleId}`, {
                action: rule.enabled ? "disable" : "enable",
                ruleId: rule.ruleId,
              })
            }
          />,
        ]
      : []),
    ...(rule?.deletedAt === null && rule.revision > 1
      ? [
          <ListActionRow
            key="revert"
            label="Revert to previous revision"
            description={actionDescription ?? `Current revision: ${rule.revision}`}
            disabled={disabled}
            loading={pending === `revert:${rule.ruleId}`}
            onPress={() =>
              onMutate(`revert:${rule.ruleId}`, { action: "revert", ruleId: rule.ruleId })
            }
          />,
        ]
      : []),
    cell.effectiveMode === "off" ? (
      <ListActionRow
        key="turn-on"
        label="Turn back on"
        description={
          turnBackOnRule
            ? (actionDescription ?? "Delete this model-specific off rule.")
            : "This model inherits a broader off rule. Create a model variant on web or desktop to override it."
        }
        disabled={disabled || turnBackOnRule === null}
        loading={turnBackOnRule !== null && pending === `turn-on:${turnBackOnRule.ruleId}`}
        onPress={() => {
          if (turnBackOnRule)
            onMutate(`turn-on:${turnBackOnRule.ruleId}`, {
              action: "delete",
              ruleId: turnBackOnRule.ruleId,
            });
        }}
      />
    ) : (
      <ListActionRow
        key="turn-off"
        label="Turn off for this model"
        description={actionDescription ?? `${cell.driver} · ${cell.model}`}
        disabled={disabled}
        loading={pending === `off:${cell.driver}:${cell.model}`}
        onPress={confirmTurnOff}
      />
    ),
    ...(rule?.deletedAt === null && rule !== turnBackOnRule
      ? [
          <ListActionRow
            key="delete"
            tone="danger"
            label="Delete rule"
            description={actionDescription ?? `Target: ${skillRuleTargetLabel(rule)}`}
            disabled={disabled}
            loading={pending === `delete:${rule.ruleId}`}
            onPress={() => confirmDelete(rule)}
          />,
        ]
      : []),
  ];

  return (
    <SettingsSection title={`${cell.driver} · ${cell.model}`}>
      <View className="gap-3 p-4">
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">Delivery, gating, and mode</Text>
          <Text className="text-sm text-foreground-muted">
            {skillDeliveryLabel(cell)} · {skillGatingLabel(cell)} · {skillEffectiveModeLabel(cell)}
          </Text>
          <Text className="text-xs text-foreground-muted">{skillGatingDescription(cell)}</Text>
          <Text className="text-xs text-foreground-muted">{ruleDescription}</Text>
        </View>
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">Controlled evidence</Text>
          <Text className="text-sm text-foreground">
            {skillVerdictLabel(cell.verdict)} · {formatSkillEffect(cell.verdict.effect)} effect
          </Text>
          <Text className="text-xs leading-relaxed text-foreground-muted">
            95% CI {formatSkillInterval(cell.verdict.ciLow, cell.verdict.ciHigh)} · n=
            {cell.verdict.nTasks} tasks{reason ? ` · ${reason}` : ""}
          </Text>
        </View>
        <View className="gap-1">
          <Text className="text-sm font-t3-medium text-foreground">
            Observational usage (confounded)
          </Text>
          <Text className="text-xs leading-relaxed text-foreground-muted">
            {skillObservationalSummary(cell)}
          </Text>
          <Text className="text-xs leading-relaxed text-foreground-muted">
            Observational counts describe real turns but do not establish that the skill caused the
            outcome.
          </Text>
        </View>
      </View>
      {actionRows.map((row, index) => (
        <View key={row.key ?? index} className="border-t border-border-subtle">
          {row}
        </View>
      ))}
    </SettingsSection>
  );
}

export function SettingsSkillDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly skillName: string;
}>) {
  const { environmentId, skillName } = route.params;
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const supported = hasSkillsCapability(environment?.serverConfig?.environment.capabilities);
  const detail = useEnvironmentQuery(
    supported ? skillEnvironment.reviewDetail({ environmentId, input: { skillName } }) : null,
  );
  const canMutate = useAtomValue(skillEnvironment.mutateVariant.permissionAtom(environmentId));
  const mutate = useAtomCommand(skillEnvironment.mutateVariant, {
    label: "skill variant mutation",
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runMutation(key: string, input: SkillVariantMutateInput) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(key);
    setError(null);
    const result = await mutate({ environmentId, input });
    pendingRef.current = false;
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(mutationErrorMessage(squashAtomCommandFailure(result)));
    }
  }

  const value = detail.data?.skillName === skillName ? detail.data : null;
  const removedRules = value?.rules.filter((rule) => rule.deletedAt !== null) ?? [];

  return (
    <SettingsScreen title={skillName}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!supported ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Update this server to use Skills
          </Text>
        ) : detail.error ? (
          <EmptyState
            title="Could not load skill"
            detail={detail.error}
            actionLabel="Try again"
            onAction={detail.refresh}
          />
        ) : value === null ? (
          <Text className="px-2 text-sm text-foreground-muted">Loading skill details…</Text>
        ) : (
          <>
            <View className="gap-1 px-2">
              <Text className="text-xl font-t3-bold text-foreground">{value.skillName}</Text>
              {value.description ? (
                <Text className="text-sm leading-relaxed text-foreground-muted">
                  {value.description}
                </Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">
                {environment?.label ?? environmentId}
              </Text>
            </View>

            {!canMutate ? (
              <View className="rounded-2xl border border-warning-border bg-warning p-4">
                <Text className="font-t3-medium text-warning-foreground">Read only</Text>
                <Text className="mt-1 text-sm text-warning-foreground">
                  This connection lacks settings-write permission. Variant actions are disabled.
                </Text>
              </View>
            ) : null}

            {error ? (
              <View className="rounded-2xl border border-danger-border bg-danger p-4">
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {error}
                </Text>
              </View>
            ) : null}

            {value.cells.length === 0 ? (
              <EmptyState
                title="No model evidence"
                detail="This skill has not been resolved for an available model yet."
              />
            ) : (
              value.cells.map((cell) => (
                <ModelCellSection
                  key={`${cell.driver}:${cell.model}`}
                  skillName={value.skillName}
                  cell={cell}
                  rules={value.rules}
                  canMutate={canMutate}
                  pending={pending}
                  onMutate={(key, input) => void runMutation(key, input)}
                />
              ))
            )}

            {removedRules.length > 0 ? (
              <SettingsSection
                title="Removed rules"
                footer="Restore may fail if another live rule now owns the same target."
              >
                {removedRules.map((rule, index) => (
                  <View
                    key={rule.ruleId}
                    className={index === 0 ? undefined : "border-t border-border-subtle"}
                  >
                    <ListActionRow
                      label={`Restore ${skillRuleTargetLabel(rule)}`}
                      description={`Revision ${rule.revision}`}
                      disabled={pending !== null || !canMutate}
                      loading={pending === `restore:${rule.ruleId}`}
                      onPress={() =>
                        void runMutation(`restore:${rule.ruleId}`, {
                          action: "restore",
                          ruleId: rule.ruleId,
                        })
                      }
                    />
                  </View>
                ))}
              </SettingsSection>
            ) : null}

            <View className="px-2">
              <Text className="text-sm leading-relaxed text-foreground-muted">
                Editing and forking skill bodies, managing eval tasks, and starting evaluations are
                available on web or desktop, or through an agent using the Skills MCP tools.
              </Text>
            </View>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
