import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  IssueAutomationAction,
  IssueAutomationRule,
  IssueTrackerKind,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, ScrollView, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { Menu } from "../../../components/ui/Menu";
import { SearchField } from "../../../components/ui/SearchField";
import { Sheet } from "../../../components/ui/Sheet";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../../lib/uuid";
import { issueTrackerEnvironment } from "../../../state/issueTrackers";
import { useDebouncedValue } from "../../../state/queries";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

type Container = NonNullable<StandaloneIssueTrackerDescriptor["automationContainer"]>;

/**
 * Issue status rules for one tracker: each team or board sorts its workflow statuses into Wake,
 * Snooze, and Settle, and the server organizes every thread linked to one of its issues.
 */
export function IssueAutomationSection({
  environmentId,
  tracker,
  container,
}: {
  readonly environmentId: EnvironmentId;
  readonly tracker: IssueTrackerKind;
  readonly container: Container;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    issueTrackerEnvironment.automation({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(
    issueTrackerEnvironment.saveAutomation.permissionAtom(environmentId),
  );
  const [draft, setDraft] = useState<IssueAutomationRule | null>(null);
  // A Jira site can hold hundreds of boards, so the tracker is searched a page at a time.
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const searchRef = useRef<TextInputInstance | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const searching = search.trim() !== debouncedSearch;
  const catalog = useEnvironmentQuery(
    adding && !searching
      ? issueTrackerEnvironment.automationCatalog({
          environmentId,
          input: {
            tracker,
            ...(debouncedSearch ? { query: debouncedSearch } : {}),
            ...(cursor ? { cursor } : {}),
          },
        })
      : null,
  );
  const rules = (query.data?.rules ?? []).filter((rule) => rule.tracker === tracker);
  const available = (catalog.data?.containers ?? []).filter(
    (option) => !rules.some((rule) => rule.containerId === option.id),
  );
  const nextCursor = catalog.data?.nextCursor ?? null;
  const loading = searching || catalog.isPending;
  const team = container === "team";
  const addLabel = team ? gt("Add team") : gt("Add board");
  const searchLabel = team ? gt("Search teams") : gt("Search boards");
  return (
    <SettingsSection
      title={team ? gt("Teams") : gt("Boards")}
      footer={gt("Wake, snooze, or settle threads when a linked issue's status changes.")}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={addLabel}
          disabled={!allowed || draft !== null}
          onPress={() => {
            setSearch("");
            setCursor(undefined);
            setAdding(true);
          }}
          className="min-h-9 flex-row items-center gap-1 px-2 active:opacity-70"
        >
          <SymbolView name="plus" size={14} tintColorClassName="accent-primary-text" />
          <Text className="text-sm text-primary-text">{addLabel}</Text>
        </Pressable>
      }
    >
      {adding ? (
        <Sheet title={addLabel} onClose={() => setAdding(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
          >
            <View className="gap-3 p-4">
              <View className="flex-row">
                <SearchField
                  inputRef={searchRef}
                  accessibilityLabel={searchLabel}
                  placeholder={searchLabel}
                  clearAccessibilityLabel={gt("Clear search")}
                  value={search}
                  onChangeText={(value) => {
                    setSearch(value);
                    setCursor(undefined);
                  }}
                />
              </View>
              {loading ? (
                <Text className="text-sm text-foreground-muted">{gt("Loading…")}</Text>
              ) : null}
              <View className="overflow-hidden rounded-xl">
                {available.map((option) => (
                  <ListActionRow
                    key={option.id}
                    label={option.name}
                    onPress={() => {
                      if (catalog.data === null) return;
                      setDraft({
                        id: uuidv4(),
                        enabled: true,
                        tracker,
                        workspace: catalog.data.workspace,
                        containerId: option.id,
                        containerName: option.name,
                        mappings: {},
                      });
                      setAdding(false);
                    }}
                  />
                ))}
              </View>
              {catalog.error ? (
                <>
                  <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                    {catalog.error}
                  </Text>
                  <Button label={gt("Retry")} size="compact" onPress={catalog.refresh} />
                </>
              ) : null}
              {!loading && !catalog.error && available.length === 0 && nextCursor === null ? (
                <Text className="text-sm text-foreground-muted">
                  {debouncedSearch
                    ? team
                      ? gt("No matching teams.")
                      : gt("No matching boards.")
                    : team
                      ? gt("Every team already has a rule.")
                      : gt("Every board already has a rule.")}
                </Text>
              ) : null}
              {!loading && nextCursor !== null ? (
                <Button
                  label={gt("Next page")}
                  size="compact"
                  onPress={() => setCursor(nextCursor)}
                />
              ) : null}
              {cursor ? (
                <Button
                  label={gt("First page")}
                  size="compact"
                  tone="text"
                  onPress={() => setCursor(undefined)}
                />
              ) : null}
            </View>
          </ScrollView>
        </Sheet>
      ) : null}
      {query.error ? (
        <Text accessibilityRole="alert" className="px-4 py-3 text-sm text-danger-foreground">
          {query.error}
        </Text>
      ) : null}
      {rules.map((rule) => (
        <RuleCard
          // A save replaces the generation, which resets the card's unsaved edits.
          key={`${rule.id}:${rule.generation ?? ""}`}
          environmentId={environmentId}
          rule={rule}
          container={container}
          lastReadFailed={
            query.data?.status.find((status) => status.ruleId === rule.id)?.error != null
          }
        />
      ))}
      {draft ? (
        <RuleCard
          key={draft.id}
          environmentId={environmentId}
          rule={draft}
          container={container}
          lastReadFailed={false}
          onDone={() => setDraft(null)}
        />
      ) : null}
      {rules.length === 0 && draft === null && !query.isPending ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {team
            ? gt("Add a team to organize the threads linked to its issues.")
            : gt("Add a board to organize the threads linked to its issues.")}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function RuleCard({
  environmentId,
  rule,
  container,
  lastReadFailed,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly rule: IssueAutomationRule;
  readonly container: Container;
  readonly lastReadFailed: boolean;
  /** Present for a rule not saved yet; called once it is saved or abandoned. */
  readonly onDone?: () => void;
}) {
  const gt = useGT();
  const [mappings, setMappings] = useState(rule.mappings);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const allowed = useAtomValue(
    issueTrackerEnvironment.saveAutomation.permissionAtom(environmentId),
  );
  const save = useAtomCommand(issueTrackerEnvironment.saveAutomation, {
    label: `save ${rule.containerName} status rule`,
  });
  const workflow = useEnvironmentQuery(
    issueTrackerEnvironment.automationCatalog({
      environmentId,
      input: { tracker: rule.tracker, containerId: rule.containerId },
    }),
  );
  const states = workflow.data?.states ?? [];
  const unsorted = states.filter((state) => mappings[state.id] === undefined);
  const otherWorkspace =
    workflow.data !== null &&
    workflow.data.workspace.toLowerCase() !== rule.workspace.toLowerCase();
  const dirty =
    onDone !== undefined ||
    enabled !== rule.enabled ||
    Object.keys(mappings).length !== Object.keys(rule.mappings).length ||
    Object.entries(mappings).some(([id, action]) => rule.mappings[id] !== action);
  const locked = !allowed || busy;
  const team = container === "team";
  const buckets: ReadonlyArray<{ readonly action: IssueAutomationAction; readonly label: string }> =
    [
      { action: "wake", label: gt("Wake") },
      { action: "snooze", label: gt("Snooze") },
      { action: "settle", label: gt("Settle") },
    ];
  const submit = async (remove: boolean) => {
    setBusy(true);
    setFailure(null);
    const result = await save({
      environmentId,
      input: { id: rule.id, rule: remove ? null : { ...rule, enabled, mappings } },
    });
    setBusy(false);
    if (result._tag === "Success") onDone?.();
    else setFailure(gt("The rule could not be saved."));
  };
  const alert =
    failure ??
    workflow.error ??
    (otherWorkspace
      ? gt("This rule belongs to another workspace. Add the team or board again to use it here.")
      : lastReadFailed
        ? gt("The last status check failed. Threads were left as they are.")
        : null);
  return (
    <View className="gap-3 border-t border-border-subtle p-3">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
          {rule.containerName}
        </Text>
        <ThemedSwitch
          accessibilityLabel={gt("Enable rule")}
          value={enabled}
          onValueChange={setEnabled}
          disabled={locked}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={onDone ? gt("Cancel") : team ? gt("Remove team") : gt("Remove board")}
          disabled={onDone ? busy : locked}
          onPress={() => (onDone ? onDone() : void submit(true))}
          className="min-h-9 min-w-9 items-center justify-center active:opacity-70"
        >
          <SymbolView
            name={onDone ? "xmark" : "trash"}
            size={16}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      </View>
      <Text className="text-xs text-foreground-muted">
        {team
          ? gt("Applies to threads linked to this team's issues, in every project.")
          : gt("Applies to threads linked to this board's issues, in every project.")}
      </Text>
      {buckets.map(({ action, label }) => (
        <View key={action} className="gap-1 rounded-xl bg-subtle px-3 py-2">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
            <Menu
              title={gt("Add a status to {bucket}", { bucket: label })}
              actions={
                unsorted.length > 0
                  ? unsorted.map((state) => ({ id: state.id, title: state.name }))
                  : [
                      {
                        id: "empty",
                        title: gt("Every status is in a bucket."),
                        attributes: { disabled: true },
                      },
                    ]
              }
              onPressAction={({ nativeEvent }) => {
                if (unsorted.some((state) => state.id === nativeEvent.event))
                  setMappings((current) => ({ ...current, [nativeEvent.event]: action }));
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Add a status to {bucket}", { bucket: label })}
                disabled={locked || workflow.data === null || otherWorkspace}
                className="min-h-8 min-w-8 items-center justify-center active:opacity-70"
              >
                <SymbolView name="plus" size={16} tintColorClassName="accent-primary-text" />
              </Pressable>
            </Menu>
          </View>
          <View className="min-h-3 flex-row flex-wrap gap-1.5 pb-1">
            {Object.entries(mappings)
              .filter(([, value]) => value === action)
              .map(([id]) => {
                const name = states.find((state) => state.id === id)?.name ?? id;
                return (
                  <Chip
                    key={id}
                    label={name}
                    trailingIcon="xmark"
                    size="small"
                    disabled={locked}
                    accessibilityLabel={gt("Remove {status}", { status: name })}
                    onPress={() =>
                      setMappings((current) =>
                        Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
                      )
                    }
                  />
                );
              })}
          </View>
        </View>
      ))}
      {alert ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {alert}
        </Text>
      ) : null}
      {workflow.error ? (
        <Button label={gt("Retry")} size="compact" tone="text" onPress={workflow.refresh} />
      ) : null}
      {dirty ? (
        <View className="flex-row gap-2">
          <Button
            label={gt("Save")}
            tone="primary"
            size="compact"
            disabled={locked || (enabled && (workflow.data === null || otherWorkspace))}
            onPress={() => void submit(false)}
          />
          {onDone ? null : (
            <Button
              label={gt("Discard")}
              size="compact"
              disabled={busy}
              onPress={() => {
                setMappings(rule.mappings);
                setEnabled(rule.enabled);
                setFailure(null);
              }}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}
