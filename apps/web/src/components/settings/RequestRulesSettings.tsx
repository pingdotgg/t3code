import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  RequestRewriteRule,
  RequestRewriteRuleReport,
  RequestRewriteWarning,
  RequestRulesDryRunResult,
  ThreadId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type Action = RequestRewriteRule["action"];
type Target = RequestRewriteRule["target"];

const ACTIONS: ReadonlyArray<Action> = ["remove", "replace", "add"];
const TARGETS: ReadonlyArray<Target> = ["system", "reminders", "messages", "tools"];

function useLabels() {
  const gt = useGT();
  return {
    action: { remove: gt("Remove"), replace: gt("Replace"), add: gt("Add") } satisfies Record<
      Action,
      string
    >,
    target: {
      system: gt("System prompt"),
      reminders: gt("System reminders"),
      messages: gt("All message text"),
      tools: gt("Tool descriptions"),
    } satisfies Record<Target, string>,
    warning: {
      "first-system-block": gt(
        "The first system block is no longer Claude Code's billing header or identity line. The provider rejects this with HTTP 429, and Claude Code retries for about 3 minutes before it fails.",
      ),
      "cache-breakpoint": gt(
        "This removes or changes a block that carries a prompt-cache breakpoint, so less of the prompt is read from cache.",
      ),
      "system-removed": gt(
        "No system prompt is left. The provider rejects this with HTTP 429, and Claude Code retries for about 3 minutes before it fails.",
      ),
    } satisfies Record<RequestRewriteWarning, string>,
    error: {
      "invalid-pattern": gt("The pattern is not a valid regular expression."),
      "missing-pattern": gt("Remove and Replace need a pattern."),
      "add-to-tools": gt("Add cannot target tool descriptions."),
    } satisfies Record<NonNullable<RequestRewriteRuleReport["error"]>, string>,
  };
}

/** Settings → Threads list of the owner's request rules, with an editor and a dry run. */
export function RequestRulesSection() {
  const gt = useGT();
  const labels = useLabels();
  const rules = useScopedSettings((settings) => settings.requestRewriteRules);
  const updateSettings = useUpdateScopedSettings();
  const [draft, setDraft] = useState<RequestRewriteRule | null>(null);
  // Warnings from each rule's last dry run, shown beside its switch.
  const [warnings, setWarnings] = useState<
    Readonly<Record<string, ReadonlyArray<RequestRewriteWarning>>>
  >({});
  const save = (next: ReadonlyArray<RequestRewriteRule>) =>
    updateSettings({ requestRewriteRules: next });

  return (
    <SettingsSection id="request-rules" title={gt("Request rules")}>
      <SettingsRow
        title={gt("Which sessions")}
        description={
          <T>
            Rules apply to Claude sessions opened while a rule is on. A session opened with every
            rule off keeps its direct connection until it reopens.
          </T>
        }
      />
      <SettingsRow
        title={gt("Routing through T3 Code")}
        description={
          <T>
            Those sessions send through T3 Code on this machine, which drops 5 Claude Code beta
            features, the advisor tool and global prompt caching.
          </T>
        }
      />
      <SettingsRow
        title={gt("Cache and limits")}
        description={
          <T>
            Changing a rule mid-session costs one prompt-cache rewrite. Rules also cover subagent
            and helper requests, but not text the provider adds after a request leaves.
          </T>
        }
      />
      {rules.map((rule) =>
        draft?.id === rule.id ? (
          <RuleEditor
            key={rule.id}
            draft={draft}
            onChange={setDraft}
            onWarnings={(found) => setWarnings((previous) => ({ ...previous, [rule.id]: found }))}
            onCancel={() => setDraft(null)}
            onSave={() => {
              save(rules.map((candidate) => (candidate.id === draft.id ? draft : candidate)));
              setDraft(null);
            }}
          />
        ) : (
          <SettingsRow
            key={rule.id}
            serverScoped
            settingKeys={["requestRewriteRules"]}
            title={rule.name.trim() || gt("Unnamed rule")}
            description={[
              labels.action[rule.action],
              labels.target[rule.target],
              ...(rule.action === "add" ? [] : [`/${rule.pattern ?? ""}/${rule.flags ?? "g"}`]),
            ].join(" · ")}
            status={
              (warnings[rule.id]?.length ?? 0) > 0
                ? warnings[rule.id]?.map((warning) => (
                    <p key={warning}>{labels.warning[warning]}</p>
                  ))
                : null
            }
            control={
              <>
                <Button size="xs" variant="ghost" onClick={() => setDraft(rule)}>
                  {gt("Edit")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => save(rules.filter((candidate) => candidate.id !== rule.id))}
                >
                  {gt("Delete")}
                </Button>
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={(checked) =>
                    save(
                      rules.map((candidate) =>
                        candidate.id === rule.id
                          ? { ...candidate, enabled: Boolean(checked) }
                          : candidate,
                      ),
                    )
                  }
                  aria-label={rule.name.trim() || gt("Unnamed rule")}
                />
              </>
            }
          />
        ),
      )}
      {draft !== null && !rules.some((rule) => rule.id === draft.id) ? (
        <RuleEditor
          draft={draft}
          onChange={setDraft}
          onWarnings={(found) => setWarnings((previous) => ({ ...previous, [draft.id]: found }))}
          onCancel={() => setDraft(null)}
          onSave={() => {
            save([...rules, draft]);
            setDraft(null);
          }}
        />
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["requestRewriteRules"]}
        title={gt("Add a rule")}
        description={<T>New rules start off. Nothing changes until you turn one on.</T>}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={draft !== null}
            onClick={() =>
              setDraft({
                id: randomUUID(),
                name: "",
                enabled: false,
                action: "remove",
                target: "reminders",
                pattern: "",
                flags: "g",
                text: "",
              })
            }
          >
            {gt("Add rule")}
          </Button>
        }
      />
    </SettingsSection>
  );
}

function RuleEditor(props: {
  readonly draft: RequestRewriteRule;
  readonly onChange: (draft: RequestRewriteRule) => void;
  readonly onWarnings: (warnings: ReadonlyArray<RequestRewriteWarning>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const labels = useLabels();
  const { draft, onChange } = props;
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canDryRun = useAtomValue(
    serverEnvironment.dryRunRequestRules.permissionAtom(environmentId),
  );
  const dryRunRequestRules = useAtomCommand(serverEnvironment.dryRunRequestRules);
  const [result, setResult] = useState<RequestRulesDryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const field = (id: string) => `request-rule-${draft.id}-${id}`;

  const dryRun = async (threadId: ThreadId | undefined) => {
    if (environmentId === null) return;
    setRunning(true);
    const response = await dryRunRequestRules({
      environmentId,
      input: {
        rules: [{ ...draft, enabled: true }],
        ...(threadId === undefined ? {} : { threadId }),
      },
    });
    setRunning(false);
    if (response._tag !== "Success") return;
    setResult(response.value);
    if (response.value.threadId !== undefined) {
      props.onWarnings(response.value.rules[0]?.warnings ?? []);
    }
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["requestRewriteRules"]}
      title={draft.name.trim() || gt("New rule")}
    >
      <div className="grid gap-3 pt-1 pb-3">
        <div className="grid gap-1.5">
          <Label htmlFor={field("name")}>{gt("Name")}</Label>
          <Input
            id={field("name")}
            size="sm"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>{gt("Action")}</Label>
            <Select
              value={draft.action}
              onValueChange={(value) => {
                const action = ACTIONS.find((candidate) => candidate === value);
                if (action !== undefined) onChange({ ...draft, action });
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Action")}>
                <SelectValue>{(value: Action) => labels.action[value]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ACTIONS.map((action) => (
                  <SelectItem hideIndicator key={action} value={action}>
                    {labels.action[action]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{gt("Target")}</Label>
            <Select
              value={draft.target}
              onValueChange={(value) => {
                const target = TARGETS.find((candidate) => candidate === value);
                if (target !== undefined) onChange({ ...draft, target });
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Target")}>
                <SelectValue>{(value: Target) => labels.target[value]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {TARGETS.map((target) => (
                  <SelectItem hideIndicator key={target} value={target}>
                    {labels.target[target]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        {draft.action === "add" ? null : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
            <div className="grid gap-1.5">
              <Label htmlFor={field("pattern")}>{gt("Pattern")}</Label>
              <Input
                id={field("pattern")}
                size="sm"
                value={draft.pattern ?? ""}
                onChange={(event) => onChange({ ...draft, pattern: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={field("flags")}>{gt("Flags")}</Label>
              <Input
                id={field("flags")}
                size="sm"
                value={draft.flags ?? ""}
                onChange={(event) => onChange({ ...draft, flags: event.target.value })}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              <T>
                Patterns run on every request over the whole conversation, so a slow pattern delays
                every session on this server.
              </T>
            </p>
          </div>
        )}
        {draft.action === "remove" ? null : (
          <div className="grid gap-1.5">
            <Label htmlFor={field("text")}>
              {draft.action === "add" ? gt("Text to add") : gt("Replacement ($1 inserts a group)")}
            </Label>
            <Textarea
              id={field("text")}
              size="sm"
              value={draft.text ?? ""}
              onChange={(event) => onChange({ ...draft, text: event.target.value })}
            />
          </div>
        )}
        {result === null ? null : (
          <DryRunReport
            result={result}
            environmentId={environmentId}
            running={running}
            onPickSession={(threadId) => void dryRun(threadId)}
          />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!canDryRun || running}
            onClick={() => void dryRun(result?.threadId)}
          >
            {gt("Dry run")}
          </Button>
          <Button size="xs" variant="outline" onClick={props.onCancel}>
            {gt("Cancel")}
          </Button>
          <Button size="xs" onClick={props.onSave}>
            {gt("Save")}
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}

function DryRunReport(props: {
  readonly result: RequestRulesDryRunResult;
  readonly environmentId: EnvironmentId | null;
  readonly running: boolean;
  readonly onPickSession: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const labels = useLabels();
  const { result } = props;
  if (result.threadId === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>
          No recent request to try this on. Turn a rule on, open a Claude session and send a
          message, then try again.
        </T>
      </p>
    );
  }
  const report = result.rules[0];
  return (
    <div className="grid gap-2 text-xs text-muted-foreground">
      {result.threadIds.length > 1 && props.environmentId !== null ? (
        <div className="grid gap-1.5">
          <Label>{gt("Session")}</Label>
          <Select
            value={result.threadId}
            onValueChange={(value) => {
              const threadId = result.threadIds.find((candidate) => candidate === value);
              if (threadId !== undefined) props.onPickSession(threadId);
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Session")} disabled={props.running}>
              <SelectValue>
                {(value: ThreadId) => (
                  <ThreadTitle environmentId={props.environmentId} threadId={value} />
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {result.threadIds.map((threadId) => (
                <SelectItem hideIndicator key={threadId} value={threadId}>
                  <ThreadTitle environmentId={props.environmentId} threadId={threadId} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {result.skipped !== undefined ? (
        <p>
          <T>The newest request could not be read as a model request.</T>
        </p>
      ) : report === undefined ? null : report.error !== undefined ? (
        <p>{labels.error[report.error]}</p>
      ) : report.blocks === 0 ? (
        <p>
          <T>The rule matched nothing in the newest request.</T>
        </p>
      ) : (
        <>
          <p>
            {gt("Blocks changed")}: {report.blocks} · {gt("Characters")}: −{report.removedChars} / +
            {report.addedChars}
          </p>
          {report.warnings.map((warning) => (
            <p key={warning} className="text-warning">
              {labels.warning[warning]}
            </p>
          ))}
          {report.snippets.map((snippet) => (
            <div key={`${snippet.before}\n${snippet.after}`} className="grid gap-1">
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono">
                {snippet.before}
              </pre>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono">
                {snippet.after}
              </pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ThreadTitle(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}) {
  const shell = useQuietThreadShell(
    props.environmentId === null
      ? null
      : { environmentId: props.environmentId, threadId: props.threadId },
  );
  return <>{shell?.title ?? props.threadId}</>;
}
