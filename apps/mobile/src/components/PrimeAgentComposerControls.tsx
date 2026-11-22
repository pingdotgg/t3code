import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";

const DEFAULT_MAX_TURNS = "25";
const DEFAULT_MAX_TOKENS = "200000";
const LEADING_PRIME_COMMAND_PATTERN =
  /^\/(?:goal|refine|autonomous(?:\s+--(?:max-turns|max-tokens)\s+\d+)*)(?:\s+|$)/i;

function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildCommandPrefix(
  kind: "goal" | "autonomous" | "refine",
  maxTurns: string,
  maxTokens: string,
): string {
  if (kind === "goal") return "/goal";
  if (kind === "refine") return "/refine";
  const parts = ["/autonomous"];
  const turns = parsePositiveInt(maxTurns);
  const tokens = parsePositiveInt(maxTokens);
  if (turns !== undefined) parts.push(`--max-turns ${turns}`);
  if (tokens !== undefined) parts.push(`--max-tokens ${tokens}`);
  return parts.join(" ");
}

export function applyMobilePrimeAgentCommand(
  prompt: string,
  kind: "goal" | "autonomous" | "refine",
  maxTurns: string,
  maxTokens: string,
): string {
  const prefix = buildCommandPrefix(kind, maxTurns, maxTokens);
  const remainder = prompt.trimStart().replace(LEADING_PRIME_COMMAND_PATTERN, "").trimStart();
  if (remainder.length === 0) {
    return kind === "refine" ? prefix : `${prefix} `;
  }
  return `${prefix} ${remainder}`;
}

export function PrimeAgentComposerControls(props: {
  readonly isCloudSandbox: boolean;
  readonly onApplyCommand: (transform: (prompt: string) => string) => void;
}) {
  const gt = useGT();
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [showBudget, setShowBudget] = useState(false);
  const [maxTurns, setMaxTurns] = useState(DEFAULT_MAX_TURNS);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);

  const apply = (kind: "goal" | "autonomous" | "refine") => {
    props.onApplyCommand((prompt) =>
      applyMobilePrimeAgentCommand(prompt, kind, maxTurns, maxTokens),
    );
    if (kind === "autonomous") setShowBudget(false);
  };

  return (
    <View className="mb-1.5 gap-1.5 px-3">
      {!props.isCloudSandbox && !warningDismissed ? (
        <View className="flex-row items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2">
          <SymbolView
            name="exclamationmark.triangle"
            size={15}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
          <View className="flex-1 gap-0.5">
            <Text className="text-xs font-t3-medium text-warning-foreground">
              {gt("Prime Agent is running on your local host")}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {gt(
                "Executes IPython REPL and recursive rlm.spawn locally. Switch to a cloud sandbox or set RLM depth to 0 in thread settings.",
              )}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={gt("Dismiss local host warning")}
            accessibilityRole="button"
            className="p-1"
            onPress={() => setWarningDismissed(true)}
          >
            <SymbolView
              name="xmark"
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
      ) : null}

      <View className="flex-row flex-wrap items-center gap-1.5">
        <Pressable
          accessibilityRole="button"
          className="rounded-lg border border-border bg-surface px-2.5 py-1 active:bg-subtle"
          onPress={() => apply("goal")}
        >
          <Text className="text-xs font-t3-medium text-foreground">/goal</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="rounded-lg border border-border bg-surface px-2.5 py-1 active:bg-subtle"
          onPress={() => setShowBudget((current) => !current)}
        >
          <Text className="text-xs font-t3-medium text-foreground">/autonomous</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="rounded-lg border border-border bg-surface px-2.5 py-1 active:bg-subtle"
          onPress={() => apply("refine")}
        >
          <Text className="text-xs font-t3-medium text-foreground">/refine</Text>
        </Pressable>
        <View className="ml-auto rounded-md bg-subtle px-2 py-0.5">
          <Text className="text-[11px] text-foreground-muted">
            {props.isCloudSandbox ? gt("Cloud sandbox") : gt("Local host")}
          </Text>
        </View>
      </View>

      {showBudget ? (
        <View className="gap-2 rounded-xl border border-border bg-surface p-2.5">
          <Text className="text-xs font-t3-medium text-foreground">
            {gt("Autonomous budget caps")}
          </Text>
          <View className="flex-row gap-2">
            <View className="flex-1 gap-1">
              <Text className="text-[11px] text-foreground-muted">{gt("Max turns")}</Text>
              <TextInput
                accessibilityLabel={gt("Autonomous max turns")}
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                keyboardType="number-pad"
                value={maxTurns}
                onChangeText={setMaxTurns}
                placeholder="25"
              />
            </View>
            <View className="flex-1 gap-1">
              <Text className="text-[11px] text-foreground-muted">{gt("Max tokens")}</Text>
              <TextInput
                accessibilityLabel={gt("Autonomous max tokens")}
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                keyboardType="number-pad"
                value={maxTokens}
                onChangeText={setMaxTokens}
                placeholder="200000"
              />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            className="items-center rounded-lg bg-foreground px-3 py-1.5"
            onPress={() => apply("autonomous")}
          >
            <Text className="text-xs font-t3-medium text-background">
              {gt("Insert /autonomous with budget")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
