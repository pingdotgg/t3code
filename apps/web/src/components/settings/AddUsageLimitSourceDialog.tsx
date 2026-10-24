import { type EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { SecretInput } from "./SecretInput";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * Dots and dashes in the host are kept so `foo-bar.com` and `foo.bar.com` do
 * not collide; anything else (a port's colon, a path) is folded to a dash.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceIdFromUrl(url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  return UsageLimitSourceId.make(`cliproxy-${slugify(host) || "hub"}`);
}

function sourceIdFromCommand(command: string, args: ReadonlyArray<string>): UsageLimitSourceId {
  const slug = slugify([command, ...args].join(" "))
    .slice(0, 40)
    .replace(/-+$/g, "");
  // The slug is a display hint; the hash keeps two differently-argumented
  // sources for the same executable distinct even past the cutoff.
  return UsageLimitSourceId.make(
    `command-${slug || "usage"}-${shortHash(`${command}${args.join("\0")}`)}`,
  );
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Whitespace separates arguments; single and double quotes group them. A
 * backslash only escapes a quote or another backslash, so ordinary path
 * separators in quoted Windows paths survive. An unclosed quote just runs to
 * the end of the input.
 */
function parseArgsText(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    const next = text[i + 1];
    if (ch === "\\" && (next === '"' || next === "'" || next === "\\")) {
      current += next;
      i++;
      pending = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (pending || current.length > 0) {
        args.push(current);
        current = "";
        pending = false;
      }
      continue;
    }
    current += ch;
    pending = true;
  }
  if (pending || current.length > 0) args.push(current);
  return args;
}

/**
 * The management key is sent once and kept in that server's secret store; settings only ever
 * carry a redaction marker for it afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<"cliproxy" | "command">("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const trimmedUrl = url.trim();
  const trimmedCommand = command.trim();
  const isCommand = kind === "command";
  const canSave = isCommand
    ? trimmedCommand.length > 0
    : trimmedUrl.length > 0 && managementKey.trim().length > 0;

  const reset = () => {
    setLabel("");
    setUrl("");
    setManagementKey("");
    setCommand("");
    setArgsText("");
  };

  const save = () => {
    if (!canSave) return;
    const labelField = label.trim() ? { label: label.trim() } : {};
    const args = parseArgsText(argsText);
    updateSettings({
      usageLimitSources: isCommand
        ? {
            [sourceIdFromCommand(trimmedCommand, args)]: {
              kind: "command" as const,
              ...labelField,
              command: trimmedCommand,
              args,
              enabled: true,
            },
          }
        : {
            [sourceIdFromUrl(trimmedUrl)]: {
              kind: "cliproxy" as const,
              ...labelField,
              url: trimmedUrl,
              managementKey: managementKey.trim(),
              enabled: true,
            },
          },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a usage source</DialogTitle>
          <DialogDescription>
            Show account quota next to the providers on {environmentLabel}
            {isCommand
              ? ". The command prints the accounts JSON on the server."
              : ". The key stays on that server."}
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
            <div className="flex items-center gap-2">
              <Switch
                id="usage-source-kind"
                aria-label="Run a command instead of a hub"
                checked={isCommand}
                onCheckedChange={(checked) => setKind(checked ? "command" : "cliproxy")}
              />
              <Label htmlFor="usage-source-kind">Run a command instead of a hub</Label>
            </div>
            {isCommand ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-command">Command</Label>
                  <Input
                    id="usage-source-command"
                    placeholder="/usr/local/bin/droidpool"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-args">Arguments (optional)</Label>
                  <Input
                    id="usage-source-args"
                    placeholder="list --json"
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  The command must print {'{ "accounts": [...] }'} JSON on stdout and exit 0. Keep
                  credentials inside the script, not in arguments.
                </p>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-url">Hub URL</Label>
                  <Input
                    id="usage-source-url"
                    placeholder="https://hub.example.ts.net:8318"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-key">Management key</Label>
                  <SecretInput
                    id="usage-source-key"
                    value={managementKey}
                    onChange={(event) => setManagementKey(event.target.value)}
                  />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder={
                  isCommand ? "Defaults to the command" : "Defaults to the hub's host name"
                }
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {isCommand ? "Add command" : "Add hub"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
