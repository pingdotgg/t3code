import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueAutomationAction,
  IssueAutomationRule,
  IssueTrackerKind,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";

type Container = NonNullable<StandaloneIssueTrackerDescriptor["automationContainer"]>;

/**
 * Issue status rules for one tracker: each team or board sorts its workflow statuses into Wake,
 * Snooze, and Settle, and the server organizes every thread linked to one of its issues.
 */
export function IssueAutomationSettings({
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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<IssueAutomationRule | null>(null);
  // A Jira site can hold hundreds of boards, so the tracker is searched a page at a time.
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
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
  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{team ? gt("Teams") : gt("Boards")}</h3>
          <p className="text-xs text-muted-foreground">
            {gt("Wake, snooze, or settle threads when a linked issue's status changes.")}
          </p>
        </div>
        <Menu
          open={adding && draft === null}
          onOpenChange={(open) => {
            setAdding(open);
            setSearch("");
            setCursor(undefined);
          }}
        >
          <MenuTrigger
            render={<Button size="xs" variant="outline" disabled={!allowed || draft !== null} />}
          >
            <PlusIcon />
            {team ? gt("Add team") : gt("Add board")}
          </MenuTrigger>
          <MenuPopup align="end" className="w-80">
            <MenuSearchInput
              autoFocus
              aria-label={team ? gt("Search teams") : gt("Search boards")}
              placeholder={team ? gt("Search teams") : gt("Search boards")}
              value={search}
              busy={loading}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setCursor(undefined);
              }}
            />
            {available.map((option) => (
              <MenuItem
                key={option.id}
                onClick={() => {
                  if (catalog.data === null) return;
                  setDraft({
                    id: randomUUID(),
                    enabled: true,
                    tracker,
                    workspace: catalog.data.workspace,
                    containerId: option.id,
                    containerName: option.name,
                    mappings: {},
                  });
                  setAdding(false);
                }}
              >
                {option.name}
              </MenuItem>
            ))}
            {loading ? <MenuItem disabled>{gt("Loading…")}</MenuItem> : null}
            {catalog.error ? (
              <MenuItem closeOnClick={false} onClick={catalog.refresh}>
                {gt("Retry")}
              </MenuItem>
            ) : null}
            {!loading && !catalog.error && available.length === 0 && nextCursor === null ? (
              <MenuItem disabled>
                {debouncedSearch
                  ? team
                    ? gt("No matching teams.")
                    : gt("No matching boards.")
                  : team
                    ? gt("Every team already has a rule.")
                    : gt("Every board already has a rule.")}
              </MenuItem>
            ) : null}
            {!loading && nextCursor !== null ? (
              <MenuItem closeOnClick={false} onClick={() => setCursor(nextCursor)}>
                {gt("Next page")}
              </MenuItem>
            ) : null}
            {cursor ? (
              <MenuItem closeOnClick={false} onClick={() => setCursor(undefined)}>
                {gt("First page")}
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      {query.error || catalog.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error ?? catalog.error}
        </p>
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
        <p className="text-xs text-muted-foreground">
          {team
            ? gt("Add a team to organize the threads linked to its issues.")
            : gt("Add a board to organize the threads linked to its issues.")}
        </p>
      ) : null}
    </div>
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
    if (result._tag === "Success") {
      onDone?.();
      return;
    }
    const error = squashAtomCommandFailure(result);
    setFailure(error instanceof Error ? error.message : gt("The rule could not be saved."));
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
    <section
      aria-label={rule.containerName}
      className="@container/rule space-y-3 rounded-lg border border-border/70 p-3"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium">{rule.containerName}</h4>
          <p className="text-xs text-muted-foreground">
            {team
              ? gt("Applies to threads linked to this team's issues, in every project.")
              : gt("Applies to threads linked to this board's issues, in every project.")}
          </p>
        </div>
        <Switch
          aria-label={gt("Enable rule")}
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={locked}
        />
        {onDone ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Cancel")}
            onClick={onDone}
            disabled={busy}
          >
            <XIcon />
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={team ? gt("Remove team") : gt("Remove board")}
            disabled={locked}
            onClick={() => void submit(true)}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 @min-[28rem]/rule:grid-cols-3">
        {buckets.map(({ action, label }) => (
          <div
            key={action}
            role="group"
            aria-label={label}
            className="min-w-0 space-y-2 rounded-md bg-muted/35 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{label}</span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={gt("Add a status to {bucket}", { bucket: label })}
                      disabled={locked || workflow.data === null || otherWorkspace}
                    />
                  }
                >
                  <PlusIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {unsorted.map((state) => (
                    <MenuItem
                      key={state.id}
                      onClick={() => setMappings((current) => ({ ...current, [state.id]: action }))}
                    >
                      {state.name}
                    </MenuItem>
                  ))}
                  {unsorted.length === 0 ? (
                    <MenuItem disabled>{gt("Every status is in a bucket.")}</MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1.5">
              {Object.entries(mappings)
                .filter(([, value]) => value === action)
                .map(([id]) => {
                  const name = states.find((state) => state.id === id)?.name ?? id;
                  return (
                    <Badge key={id} variant="outline" size="control" className="min-w-0">
                      <span className="truncate">{name}</span>
                      <Button
                        size="icon-tiny"
                        variant="ghost-muted"
                        aria-label={gt("Remove {status}", { status: name })}
                        disabled={locked}
                        onClick={() =>
                          setMappings((current) =>
                            Object.fromEntries(
                              Object.entries(current).filter(([key]) => key !== id),
                            ),
                          )
                        }
                      >
                        <XIcon />
                      </Button>
                    </Badge>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      {alert ? (
        <p role="alert" className="text-xs text-destructive">
          {alert}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {workflow.error ? (
          <Button size="xs" variant="ghost" onClick={workflow.refresh}>
            {gt("Retry")}
          </Button>
        ) : null}
        {dirty ? (
          <>
            <Button
              size="xs"
              disabled={locked || (enabled && (workflow.data === null || otherWorkspace))}
              onClick={() => void submit(false)}
            >
              {gt("Save")}
            </Button>
            {onDone ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setMappings(rule.mappings);
                  setEnabled(rule.enabled);
                  setFailure(null);
                }}
              >
                {gt("Discard")}
              </Button>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
