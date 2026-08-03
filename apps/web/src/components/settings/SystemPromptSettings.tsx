/**
 * Settings → System prompt (fork f2).
 *
 * Edits the ordered injection rules and renders the exact text each provider
 * instance would receive. The preview calls the same
 * `resolveSystemPromptInjection` the server does, so what is shown here is what
 * ships.
 */
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import { InfoIcon, PlusIcon, TrashIcon } from "lucide-react";
import type {
  ProviderInstanceId,
  ServerProvider,
  SystemPromptInjectionSettings,
  SystemPromptRule,
} from "@t3tools/contracts";
import {
  buildSystemPromptPreview,
  GLOBAL_SYSTEM_PROMPT_RULE_ID,
  readSystemPromptRule,
  removeSystemPromptRule,
  setSystemPromptRuleEnabled,
  systemPromptOverrideCandidates,
  systemPromptRuleId,
  upsertSystemPromptRule,
} from "@t3tools/client-runtime/state/system-prompt";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../state/server";
import { primarySupportsSystemPromptInjectionAtom } from "../../state/systemPrompt";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SCOPE_NOTE =
  "Applies when a session starts. Threads already running keep the prompt they started with.";

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

function RuleCard({
  title,
  description,
  rule,
  disabled,
  placeholder,
  onSave,
  onToggle,
  onRemove,
}: {
  readonly title: string;
  readonly description: string;
  readonly rule: SystemPromptRule | undefined;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onSave: (text: string) => void;
  readonly onToggle: ((enabled: boolean) => void) | undefined;
  readonly onRemove: (() => void) | undefined;
}) {
  const saved = rule?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const [editingFrom, setEditingFrom] = useState(saved);
  // Re-sync when the persisted text changes underneath an untouched editor.
  if (editingFrom !== saved && draft === editingFrom) {
    setEditingFrom(saved);
    setDraft(saved);
  }
  const isDirty = draft !== saved;

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <div className="flex items-center gap-2">
          {onRemove ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={onRemove}
              aria-label={`Remove ${title} rule`}
            >
              <TrashIcon className="size-3.5" />
            </Button>
          ) : null}
          {onToggle ? (
            <Switch
              checked={rule?.enabled ?? true}
              disabled={disabled || rule === undefined}
              onCheckedChange={(checked) => onToggle(Boolean(checked))}
              aria-label={`${title} enabled`}
            />
          ) : null}
        </div>
      }
    >
      <div className="mt-3 max-w-3xl space-y-2 pb-3.5">
        <Textarea
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          className="font-mono text-[13px]"
          placeholder={placeholder}
          aria-label={`${title} instructions`}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{draft.trim().length} characters</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={disabled || !isDirty}
              onClick={() => setDraft(saved)}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs"
              disabled={disabled || !isDirty}
              onClick={() => {
                setEditingFrom(draft);
                onSave(draft);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

function PreviewPanel({
  injection,
  providers,
}: {
  readonly injection: SystemPromptInjectionSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const entries = useMemo(
    () => buildSystemPromptPreview(injection, providers),
    [injection, providers],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = entries.find((entry) => entry.instanceId === selectedId) ?? entries[0];

  if (!selected) {
    return (
      <SettingsRow title="Preview" description="Enable a provider to see what it would receive." />
    );
  }

  return (
    <SettingsRow
      title="Preview"
      description="Exactly what the selected provider instance receives when a session starts."
      control={
        <Select value={selected.instanceId} onValueChange={(value) => setSelectedId(String(value))}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Preview provider instance">
            <SelectValue>{selected.displayName}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {entries.map((entry) => (
              <SelectItem key={entry.instanceId} hideIndicator value={entry.instanceId}>
                {entry.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      <div className="mt-3 max-w-3xl space-y-2 pb-3.5">
        {selected.support === "unsupported" ? (
          <p className="rounded-lg bg-muted/40 px-3 py-3 text-[13px] leading-[1.5] text-muted-foreground">
            {selected.displayName} doesn&apos;t accept custom instructions. Nothing is sent.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">Session instructions</span>
              <Badge variant="secondary" size="sm">
                {selected.text?.length ?? 0} chars
              </Badge>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-3 font-mono text-[12px] leading-[1.5] text-foreground/90">
              {selected.text ?? "Nothing is sent."}
            </pre>
            {selected.driverKind === "codex" ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                Codex also receives T3 Code&apos;s built-in collaboration-mode instructions with
                every turn. Those are separate from the text above.
              </p>
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

export function SystemPromptSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const supported = useAtomValue(primarySupportsSystemPromptInjectionAtom);
  const injection = settings.systemPromptInjection;

  const applyInjection = (next: SystemPromptInjectionSettings) => {
    updateSettings({ systemPromptInjection: next });
  };

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider])),
    [providers],
  );
  const overrideRules = injection.rules.filter(
    (rule) => rule.id !== GLOBAL_SYSTEM_PROMPT_RULE_ID && rule.match.instanceId !== undefined,
  );
  const candidates = systemPromptOverrideCandidates(injection, providers);

  const saveRule = (instanceId: ProviderInstanceId | undefined, text: string) => {
    const id = systemPromptRuleId(instanceId);
    const existing = readSystemPromptRule(injection, instanceId);
    applyInjection(
      upsertSystemPromptRule(injection, {
        id,
        enabled: existing?.enabled ?? true,
        match: instanceId === undefined ? {} : { instanceId },
        text,
      }),
    );
  };

  if (!supported) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("system-prompt")} title="System prompt">
          <SettingsRow
            title="Not available on this server"
            description="This server doesn't apply custom system prompt instructions. Update it to use this section."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("system-prompt")} title="System prompt">
        <SettingsRow
          title="Inject custom instructions"
          description="Adds your text to every new provider session that supports it, on top of the provider's own system prompt."
          status={SCOPE_NOTE}
          control={
            <Switch
              checked={injection.enabled}
              onCheckedChange={(checked) =>
                applyInjection({ ...injection, enabled: Boolean(checked) })
              }
              aria-label="Inject custom instructions"
            />
          }
        />

        <RuleCard
          title="Global"
          description="Sent to every provider instance that accepts instructions."
          rule={readSystemPromptRule(injection)}
          disabled={!injection.enabled}
          placeholder="Always answer in British English. Prefer rg over grep."
          onSave={(text) => saveRule(undefined, text)}
          onToggle={(enabled) =>
            applyInjection(
              setSystemPromptRuleEnabled(injection, GLOBAL_SYSTEM_PROMPT_RULE_ID, enabled),
            )
          }
          onRemove={undefined}
        />
      </SettingsSection>

      <SettingsSection
        title="Per-provider overrides"
        headerAction={
          candidates.length > 0 ? (
            <Select
              value=""
              onValueChange={(value) => {
                const instanceId = String(value) as ProviderInstanceId;
                applyInjection(
                  upsertSystemPromptRule(injection, {
                    id: systemPromptRuleId(instanceId),
                    enabled: true,
                    match: { instanceId },
                    text: "",
                  }),
                );
              }}
            >
              <SelectTrigger
                className="h-7 gap-1.5 px-2 text-xs"
                aria-label="Add a provider override"
              >
                <PlusIcon className="size-3.5" />
                <SelectValue>Add override</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {candidates.map((provider) => (
                  <SelectItem key={provider.instanceId} hideIndicator value={provider.instanceId}>
                    {providerLabel(provider)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null
        }
      >
        {overrideRules.length === 0 ? (
          <SettingsRow
            title="No overrides"
            description="Add one to send extra instructions to a single provider instance."
          />
        ) : (
          overrideRules.map((rule) => {
            const instanceId = rule.match.instanceId as ProviderInstanceId;
            const provider = providerById.get(instanceId);
            return (
              <RuleCard
                key={rule.id}
                title={provider ? providerLabel(provider) : instanceId}
                description="Sent after the global text, to this instance only."
                rule={rule}
                disabled={!injection.enabled}
                placeholder="Instructions for this provider instance."
                onSave={(text) => saveRule(instanceId, text)}
                onToggle={(enabled) =>
                  applyInjection(setSystemPromptRuleEnabled(injection, rule.id, enabled))
                }
                onRemove={() => applyInjection(removeSystemPromptRule(injection, rule.id))}
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="Preview">
        <PreviewPanel injection={injection} providers={providers} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
