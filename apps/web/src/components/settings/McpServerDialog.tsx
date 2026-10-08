import type { McpServerConfig, McpServerTransport } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EMPTY_MCP_SERVER_DRAFT,
  mcpServerDraftFrom,
  type McpServerDraft,
  mcpServerFromDraft,
  type McpVariableDraft,
  nextMcpVariableDraftId,
  parseMcpServerJson,
} from "./toolsSettings.logic";

/**
 * Add or edit one MCP server. Pasting the JSON snippet from a vendor's docs
 * fills the form; secrets in env vars and headers default to sensitive, so
 * they are stored on the environment's secret store and never sent back.
 */
export function McpServerDialog({
  open,
  onOpenChange,
  scopeLabel,
  initial,
  takenNames,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the server is saved, e.g. "This Mac" or a project name. */
  readonly scopeLabel: string;
  readonly initial: { readonly name: string; readonly config: McpServerConfig } | null;
  readonly takenNames: ReadonlySet<string>;
  readonly onSave: (server: { name: string; transport: McpServerTransport }) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<McpServerDraft>(() =>
    initial ? mcpServerDraftFrom(initial.name, initial.config) : EMPTY_MCP_SERVER_DRAFT,
  );
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const result = mcpServerFromDraft(draft, takenNames);
  const error = attempted && !result.ok ? result : null;

  const update = (patch: Partial<McpServerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const variablesKey = draft.type === "stdio" ? "env" : "headers";
  const variables = draft[variablesKey];
  const setVariables = (next: ReadonlyArray<McpVariableDraft>) => update({ [variablesKey]: next });

  const applyPaste = (text: string) => {
    setPaste(text);
    if (text.trim().length === 0) {
      setPasteError(false);
      return;
    }
    const parsed = parseMcpServerJson(text);
    setPasteError(parsed === null);
    if (parsed !== null) {
      setDraft((current) => ({ ...parsed, name: parsed.name || current.name }));
    }
  };

  const save = () => {
    setAttempted(true);
    if (!result.ok) return;
    onSave({ name: result.name, transport: result.transport });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit ${initial.name}` : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            Saved for {scopeLabel}. Agents get it in their next session.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {initial === null ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-paste`}>Paste config (optional)</Label>
                <Textarea
                  id={`${id}-paste`}
                  size="sm"
                  rows={3}
                  placeholder={'{ "linear": { "url": "https://mcp.linear.app/mcp" } }'}
                  value={paste}
                  onChange={(event) => applyPaste(event.target.value)}
                  spellCheck={false}
                />
                {pasteError ? (
                  <p className="text-xs text-destructive-foreground">
                    Couldn't find a server in that JSON. Fill in the fields below instead.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                font="mono"
                placeholder="linear"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value.toLowerCase() })}
                aria-invalid={error?.field === "name" || undefined}
                autoFocus={initial !== null}
                spellCheck={false}
              />
              {error?.field === "name" ? (
                <p className="text-xs text-destructive-foreground">{error.message}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <ToggleGroup
                aria-label="Server type"
                variant="segmented"
                value={[draft.type]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "stdio" || value === "http") update({ type: value });
                }}
              >
                <Toggle value="stdio">Command</Toggle>
                <Toggle value="http">URL</Toggle>
              </ToggleGroup>
            </div>
            {draft.type === "stdio" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-command`}>Command</Label>
                  <Input
                    id={`${id}-command`}
                    font="mono"
                    placeholder="npx"
                    value={draft.command}
                    onChange={(event) => update({ command: event.target.value })}
                    aria-invalid={error?.field === "command" || undefined}
                    spellCheck={false}
                  />
                  {error?.field === "command" ? (
                    <p className="text-xs text-destructive-foreground">{error.message}</p>
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-args`}>Arguments</Label>
                  <Input
                    id={`${id}-args`}
                    font="mono"
                    placeholder="-y @playwright/mcp@latest"
                    value={draft.args}
                    onChange={(event) => update({ args: event.target.value })}
                    spellCheck={false}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-url`}>URL</Label>
                <Input
                  id={`${id}-url`}
                  font="mono"
                  placeholder="https://mcp.example.com/mcp"
                  value={draft.url}
                  onChange={(event) => update({ url: event.target.value })}
                  aria-invalid={error?.field === "url" || undefined}
                  spellCheck={false}
                />
                {error?.field === "url" ? (
                  <p className="text-xs text-destructive-foreground">{error.message}</p>
                ) : null}
              </div>
            )}
            <VariablesEditor
              label={draft.type === "stdio" ? "Environment variables" : "Headers"}
              namePlaceholder={draft.type === "stdio" ? "API_KEY" : "Authorization"}
              variables={variables}
              onChange={setVariables}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>{initial ? "Save" : "Add server"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function VariablesEditor({
  label,
  namePlaceholder,
  variables,
  onChange,
}: {
  readonly label: string;
  readonly namePlaceholder: string;
  readonly variables: ReadonlyArray<McpVariableDraft>;
  readonly onChange: (next: ReadonlyArray<McpVariableDraft>) => void;
}) {
  const update = (id: string, patch: Partial<McpVariableDraft>) =>
    onChange(
      variables.map((variable) =>
        variable.id === id
          ? {
              ...variable,
              ...patch,
              // Typing a value replaces a stored secret.
              ...(patch.value !== undefined ? { stored: false } : {}),
            }
          : variable,
      ),
    );
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange([
              ...variables,
              { id: nextMcpVariableDraftId(), name: "", value: "", sensitive: true, stored: false },
            ])
          }
        >
          <PlusIcon className="size-3" aria-hidden />
          Add
        </Button>
      </div>
      {variables.length === 0 ? null : (
        <div className="grid gap-1.5">
          {variables.map((variable, index) => (
            <div key={variable.id} className="flex min-w-0 items-center gap-1.5">
              <Input
                size="sm"
                font="mono"
                className="w-36 shrink-0"
                placeholder={namePlaceholder}
                value={variable.name}
                onChange={(event) => update(variable.id, { name: event.target.value })}
                aria-label={`${label} name ${index + 1}`}
                spellCheck={false}
              />
              <Input
                size="sm"
                font="mono"
                className="min-w-0 flex-1"
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={variable.stored ? "Stored secret, type to replace" : "value"}
                value={variable.value}
                onChange={(event) => update(variable.id, { value: event.target.value })}
                aria-label={`${label} value ${index + 1}`}
                spellCheck={false}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-pressed={variable.sensitive}
                      aria-label={`Mark ${variable.name || `${label} ${index + 1}`} as secret`}
                      onClick={() =>
                        update(variable.id, {
                          sensitive: !variable.sensitive,
                          // A stored secret cannot become plain text without a new value.
                          ...(variable.stored ? { stored: false, value: "" } : {}),
                        })
                      }
                    />
                  }
                >
                  {variable.sensitive ? (
                    <LockIcon className="size-3" />
                  ) : (
                    <LockOpenIcon className="size-3" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {variable.sensitive ? "Secret, kept on the server" : "Plain text"}
                </TooltipPopup>
              </Tooltip>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                aria-label={`Remove ${variable.name || `${label} ${index + 1}`}`}
                onClick={() => onChange(variables.filter((entry) => entry.id !== variable.id))}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
