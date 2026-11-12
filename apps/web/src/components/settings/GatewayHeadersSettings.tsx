import type { DesktopGatewayHeadersEntry, DesktopGatewayHeadersInput } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  desktopGatewayHeadersStateAtom,
  refreshDesktopGatewayHeadersState,
} from "~/state/desktopGatewayHeaders";
import { useEnvironmentQuery } from "~/state/query";
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  formatDesktopBridgeError,
  formatGatewayOrigin,
  type GatewayHeadersDraft,
  isCloudflareAccessHeaderNames,
  makeGatewayHeaderRow,
  makeGatewayHeadersDraft,
  resolveGatewayHeadersInput,
} from "./ConnectionsSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SecretInput } from "./SecretInput";
import { searchableSetting } from "./settingsSearch";

/** Matches the field labels of the Add environment dialog, where these fields also appear. */
const FIELD_LABEL_CLASSNAME = "mb-1.5 block text-xs font-medium text-foreground";

export function GatewayHeadersFields({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: GatewayHeadersDraft;
  readonly disabled: boolean;
  readonly onChange: (draft: GatewayHeadersDraft) => void;
}) {
  const setRows = (rows: GatewayHeadersDraft["rows"]) =>
    onChange({ ...draft, rows: rows.length > 0 ? rows : [makeGatewayHeaderRow()] });
  const updateRow = (rowId: string, change: { name?: string; value?: string }) =>
    setRows(draft.rows.map((row) => (row.id === rowId ? { ...row, ...change } : row)));

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        aria-label="Access proxy"
        className="w-full *:flex-1"
        disabled={disabled}
        value={[draft.kind]}
        onValueChange={(next) => {
          const kind = next[0];
          if (kind === "cloudflare" || kind === "custom") onChange({ ...draft, kind });
        }}
      >
        <Toggle value="cloudflare">Cloudflare Access</Toggle>
        <Toggle value="custom">Custom headers</Toggle>
      </ToggleGroup>
      {draft.kind === "cloudflare" ? (
        <div className="flex flex-col gap-1.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className={FIELD_LABEL_CLASSNAME}>Client ID</span>
              <Input
                value={draft.clientId}
                onChange={(event) => onChange({ ...draft, clientId: event.target.value })}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="block min-w-0">
              <span className={FIELD_LABEL_CLASSNAME}>Client secret</span>
              <SecretInput
                value={draft.clientSecret}
                onChange={(event) => onChange({ ...draft, clientSecret: event.target.value })}
                placeholder=""
                disabled={disabled}
              />
            </label>
          </div>
          <p className="text-2xs text-muted-foreground">
            From a service token in Cloudflare Zero Trust, under Access → Service credentials.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {draft.rows.map((row, index) => (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
            >
              <Input
                aria-label={`Header ${index + 1} name`}
                value={row.name}
                onChange={(event) => updateRow(row.id, { name: event.target.value })}
                placeholder="Header name"
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
              <SecretInput
                aria-label={`Header ${index + 1} value`}
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder="Value"
                disabled={disabled}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove header ${index + 1}`}
                disabled={disabled || (draft.rows.length === 1 && !row.name && !row.value)}
                onClick={() => setRows(draft.rows.filter((candidate) => candidate.id !== row.id))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => setRows([...draft.rows, makeGatewayHeaderRow()])}
            >
              <PlusIcon />
              Add header
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface GatewayHeadersDialogTarget {
  readonly open: boolean;
  /** `null` adds headers for a new host. */
  readonly origin: string | null;
  readonly headerNames: ReadonlyArray<string>;
  readonly session: number;
}

function GatewayHeadersDialog({
  target,
  onClose,
}: {
  readonly target: GatewayHeadersDialogTarget;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [host, setHost] = useState("");
  const [draft, setDraft] = useState(() => makeGatewayHeadersDraft(target.headerNames));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let input: DesktopGatewayHeadersInput;
    try {
      input = resolveGatewayHeadersInput({ origin: target.origin, host, draft });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the headers.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await bridge.setGatewayHeaders(input);
      refreshDesktopGatewayHeadersState();
      toastManager.add({
        type: "success",
        title: "Access proxy headers saved",
        description: `Requests to ${formatGatewayOrigin(input.origin)} now carry them.`,
      });
      onClose();
    } catch (cause) {
      setError(formatDesktopBridgeError(cause, "Could not save the headers."));
    }
    setSaving(false);
  };

  return (
    <Dialog open={target.open} onOpenChange={(open) => (open || saving ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target.origin === null
              ? "Add access proxy headers"
              : `Replace headers for ${formatGatewayOrigin(target.origin)}`}
          </DialogTitle>
          <DialogDescription>
            The desktop app sends these with every request to this host. They stay encrypted on this
            device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={`${id}-form`}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {target.origin === null ? (
              <label className="block">
                <span className={FIELD_LABEL_CLASSNAME}>Host</span>
                <Input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="code.example.com"
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <GatewayHeadersFields draft={draft} disabled={saving} onChange={setDraft} />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function describeHeaderNames(names: ReadonlyArray<string>): string {
  return isCloudflareAccessHeaderNames(names)
    ? "Cloudflare Access service token"
    : names.join(", ");
}

function GatewayHeadersRow({
  entry,
  onReplace,
}: {
  readonly entry: DesktopGatewayHeadersEntry;
  readonly onReplace: (entry: DesktopGatewayHeadersEntry) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const host = formatGatewayOrigin(entry.origin);
  const remove = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const confirmed = await requestConfirmDialog(
      `Stop sending headers to ${host}?\nEnvironments behind its access proxy will stop connecting.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRemoving(true);
    try {
      await bridge.removeGatewayHeaders(entry.origin);
      refreshDesktopGatewayHeadersState();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not remove the headers",
        description: formatDesktopBridgeError(cause, "Try again."),
      });
    }
    setRemoving(false);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{host}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {describeHeaderNames(entry.headerNames)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={removing} onClick={() => onReplace(entry)}>
            Replace
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Desktop-only: a browser cannot add headers to a WebSocket, so the web apps cannot offer this. */
export function GatewayHeadersSettings() {
  const gatewayHeaders = useEnvironmentQuery(desktopGatewayHeadersStateAtom);
  const [dialogTarget, setDialogTarget] = useState<GatewayHeadersDialogTarget>({
    open: false,
    origin: null,
    headerNames: [],
    session: 0,
  });
  const entries = gatewayHeaders.data ?? [];
  const openDialog = (entry: DesktopGatewayHeadersEntry | null) =>
    setDialogTarget((current) => ({
      open: true,
      origin: entry?.origin ?? null,
      headerNames: entry?.headerNames ?? [],
      session: current.session + 1,
    }));

  const { id, title } = searchableSetting("access-gateways");
  return (
    <>
      <FoldedSettingsSection
        id={id}
        title={title}
        summary={
          entries.length === 0
            ? null
            : entries.map((entry) => formatGatewayOrigin(entry.origin)).join(" · ")
        }
        control={
          <Button size="xs" variant="ghost-muted" onClick={() => openDialog(null)}>
            <PlusIcon />
            Add
          </Button>
        }
      >
        {entries.length === 0 ? (
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            {gatewayHeaders.error ??
              "For a T3 Code server behind Cloudflare Access or another access proxy. The desktop app sends these headers with every request to that host."}
          </p>
        ) : (
          entries.map((entry) => (
            <GatewayHeadersRow key={entry.origin} entry={entry} onReplace={openDialog} />
          ))
        )}
      </FoldedSettingsSection>
      <GatewayHeadersDialog
        key={dialogTarget.session}
        target={dialogTarget}
        onClose={() => setDialogTarget((current) => ({ ...current, open: false }))}
      />
    </>
  );
}
