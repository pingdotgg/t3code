import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  isSecretReference,
  type PrinterConfig,
  type PrinterId,
  type PrinterKind,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckCircle2, Plus, Printer, Server, Trash2, Wrench, X } from "lucide-react";
import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { SecretSourceInput, useSecretSources } from "~/components/settings/SecretSourceInput";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { selectEnvironmentAxis } from "~/components/settings/settingsScopeAxis";
import { useScopedSettings } from "~/components/settings/useScopedSettings";
import { printerEnvironment, useFleetPrinters, usePrinterState } from "~/state/printer";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

type SecretDraftState =
  | { readonly kind: "saved"; readonly original: SettingsSecretValue }
  | { readonly kind: "new"; readonly value: SettingsSecretValue }
  | { readonly kind: "cleared" };

interface PrinterDraft {
  readonly id: string;
  readonly existingId?: PrinterId | undefined;
  readonly kind: PrinterKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly secret: SecretDraftState;
  readonly entityPrefix: string;
  readonly deviceId: string;
  readonly webcamUrl: string;
  readonly pollIntervalSeconds: number;
}

function slugifyPrinterId(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "printer-1";
}

function ensureUniquePrinterId(
  desired: string,
  existing: ReadonlyArray<PrinterConfig>,
  ignoreId?: PrinterId,
): PrinterId {
  const used = new Set(
    existing.filter((entry) => entry.id !== ignoreId).map((entry) => entry.id as string),
  );
  const base = desired.trim() || "printer-1";
  if (!used.has(base)) return base as PrinterId;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}` as PrinterId;
}

function secretStateFromExisting(raw: SettingsSecretValue): SecretDraftState {
  if (raw === "" || (typeof raw === "string" && raw.trim() === "")) {
    return { kind: "cleared" };
  }
  return { kind: "saved", original: raw };
}

function draftFromConfig(config: PrinterConfig): PrinterDraft {
  const rawSecret = config.kind === "home-assistant-bambu" ? config.accessToken : config.apiKey;
  return {
    id: config.id,
    existingId: config.id,
    kind: config.kind,
    label: config.label,
    baseUrl: config.baseUrl,
    secret: secretStateFromExisting(rawSecret),
    entityPrefix: config.kind === "home-assistant-bambu" ? (config.entityPrefix ?? "") : "",
    deviceId: config.kind === "home-assistant-bambu" ? (config.deviceId ?? "") : "",
    webcamUrl: config.kind !== "home-assistant-bambu" ? (config.webcamUrl ?? "") : "",
    pollIntervalSeconds: config.pollIntervalSeconds,
  };
}

function emptyDraft(existing: ReadonlyArray<PrinterConfig>, defaultLabel: string): PrinterDraft {
  const uniqueId = ensureUniquePrinterId(slugifyPrinterId(defaultLabel), existing);
  return {
    id: uniqueId,
    kind: "home-assistant-bambu",
    label: defaultLabel,
    baseUrl: "",
    secret: { kind: "cleared" },
    entityPrefix: "",
    deviceId: "",
    webcamUrl: "",
    pollIntervalSeconds: 4,
  };
}

function resolveSecretValueForSave(secret: SecretDraftState): SettingsSecretValue {
  switch (secret.kind) {
    case "saved":
      return secret.original;
    case "new":
      return secret.value;
    case "cleared":
      return "";
  }
}

function configFromDraft(
  draft: PrinterDraft,
  existing: ReadonlyArray<PrinterConfig>,
): PrinterConfig {
  const id = draft.existingId
    ? draft.existingId
    : ensureUniquePrinterId(draft.id.trim() || slugifyPrinterId(draft.label), existing);
  const label = draft.label.trim() || id;
  const baseUrl = draft.baseUrl.trim();
  const secretValue = resolveSecretValueForSave(draft.secret);
  const pollIntervalSeconds = Math.max(2, Math.min(60, Math.round(draft.pollIntervalSeconds || 4)));

  if (draft.kind === "home-assistant-bambu") {
    return {
      kind: "home-assistant-bambu",
      id,
      label,
      baseUrl,
      accessToken: secretValue,
      ...(draft.entityPrefix.trim() ? { entityPrefix: draft.entityPrefix.trim() } : {}),
      ...(draft.deviceId.trim() ? { deviceId: draft.deviceId.trim() } : {}),
      pollIntervalSeconds,
    };
  }
  if (draft.kind === "moonraker") {
    return {
      kind: "moonraker",
      id,
      label,
      baseUrl,
      apiKey: secretValue,
      ...(draft.webcamUrl.trim() ? { webcamUrl: draft.webcamUrl.trim() } : {}),
      pollIntervalSeconds,
    };
  }
  return {
    kind: "octoprint",
    id,
    label,
    baseUrl,
    apiKey: secretValue,
    ...(draft.webcamUrl.trim() ? { webcamUrl: draft.webcamUrl.trim() } : {}),
    pollIntervalSeconds,
  };
}

function PrinterKindLabel({ kind }: { readonly kind: PrinterKind }) {
  const gt = useGT();
  switch (kind) {
    case "home-assistant-bambu":
      return <>{gt("Home Assistant (Bambu Lab)")}</>;
    case "moonraker":
      return <>{gt("Moonraker (Klipper)")}</>;
    case "octoprint":
      return <>{gt("OctoPrint")}</>;
  }
}

function PrinterEditorForm({
  environmentId,
  existingPrinters,
  initialDraft,
  disabled,
  onSave,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly existingPrinters: ReadonlyArray<PrinterConfig>;
  readonly initialDraft: PrinterDraft;
  readonly disabled: boolean;
  readonly onSave: (config: PrinterConfig, existingId?: PrinterId) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const fieldPrefix = useId();
  const sources = useSecretSources(environmentId);
  const canTest = useAtomValue(printerEnvironment.testConnection.permissionAtom(environmentId));
  const testConnection = useAtomCommand(printerEnvironment.testConnection, {
    reportFailure: false,
  });

  const [draft, setDraft] = useState<PrinterDraft>(initialDraft);
  const [secretValid, setSecretValid] = useState(true);
  const [secretCleared, setSecretCleared] = useState(false);
  const [secretInputKey, setSecretInputKey] = useState(0);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    readonly ok: boolean;
    readonly summary: string;
  } | null>(null);

  const secretLabel =
    draft.kind === "home-assistant-bambu" ? gt("Home Assistant token") : gt("API key (optional)");
  const savedOriginal =
    initialDraft.secret.kind === "saved" ? initialDraft.secret.original : undefined;
  const isSavedLiteral =
    draft.secret.kind === "saved" &&
    typeof draft.secret.original === "string" &&
    draft.secret.original.length > 0;
  const secretInputValue: SettingsSecretValue =
    draft.secret.kind === "new"
      ? draft.secret.value
      : draft.secret.kind === "saved" && isSecretReference(draft.secret.original)
        ? draft.secret.original
        : "";

  const handleTest = async () => {
    if (!canTest || testing || !secretValid) return;
    setTesting(true);
    setTestResult(null);
    try {
      const config = configFromDraft(draft, existingPrinters);
      const result = await testConnection({
        environmentId,
        input: {
          config,
          ...(draft.existingId && draft.secret.kind === "saved"
            ? { existingPrinterId: draft.existingId }
            : {}),
        },
      });
      if (result._tag === "Failure") {
        setTestResult({ ok: false, summary: formatEnvironmentQueryError(result.cause) });
      } else {
        setTestResult({ ok: true, summary: result.value.summary });
        if (draft.kind === "home-assistant-bambu") {
          setDraft((current) => ({
            ...current,
            entityPrefix: current.entityPrefix || result.value.detectedEntityPrefix || "",
            deviceId: current.deviceId || result.value.detectedDeviceId || "",
          }));
        }
      }
    } catch (error) {
      setTestResult({
        ok: false,
        summary: error instanceof Error ? error.message : String(error),
      });
    }
    setTesting(false);
  };

  const handleSubmit = async () => {
    if (saving || disabled || !secretValid) return;
    setSaving(true);
    try {
      const config = configFromDraft(draft, existingPrinters);
      await onSave(config, draft.existingId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not save 3D printer settings"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setSaving(false);
  };

  const backendId = `${fieldPrefix}-backend`;
  const labelId = `${fieldPrefix}-label`;
  const baseUrlId = `${fieldPrefix}-base-url`;
  const secretId = `${fieldPrefix}-secret`;
  const prefixId = `${fieldPrefix}-entity-prefix`;
  const deviceIdField = `${fieldPrefix}-device-id`;
  const webcamId = `${fieldPrefix}-webcam-url`;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={backendId} className="text-xs font-medium text-foreground">
            {gt("Printer backend")}
          </label>
          <Select
            value={draft.kind}
            onValueChange={(value) => {
              if (!value || value === draft.kind) return;
              setTestResult(null);
              // Permanently clear the previous backend's saved secret & remount SecretSourceInput so switching back never resurrects it.
              setSecretCleared(true);
              setSecretValid(true);
              setSecretInputKey((n) => n + 1);
              setDraft((current) => ({
                ...current,
                kind: value as PrinterKind,
                secret: { kind: "cleared" },
                entityPrefix: "",
                deviceId: "",
                webcamUrl: "",
              }));
            }}
          >
            <SelectTrigger id={backendId}>
              <SelectValue>
                <PrinterKindLabel kind={draft.kind} />
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="home-assistant-bambu">
                {gt("Home Assistant (Bambu Lab)")}
              </SelectItem>
              <SelectItem value="moonraker">{gt("Moonraker (Klipper)")}</SelectItem>
              <SelectItem value="octoprint">{gt("OctoPrint")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>

        <div className="space-y-1">
          <label htmlFor={labelId} className="text-xs font-medium text-foreground">
            {gt("Display name")}
          </label>
          <Input
            id={labelId}
            value={draft.label}
            placeholder={gt("Bambu Lab P1S")}
            onChange={(event) => {
              const label = event.target.value;
              setDraft((current) => ({
                ...current,
                label,
                id: current.existingId ? current.id : slugifyPrinterId(label),
              }));
            }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={baseUrlId} className="text-xs font-medium text-foreground">
            {draft.kind === "home-assistant-bambu"
              ? gt("Home Assistant URL")
              : gt("Printer host URL")}
          </label>
          <Input
            id={baseUrlId}
            value={draft.baseUrl}
            placeholder={
              draft.kind === "home-assistant-bambu"
                ? "http://homeassistant.local:8123"
                : draft.kind === "moonraker"
                  ? "http://printer.local:7125"
                  : "http://octopi.local"
            }
            onChange={(event) => {
              setTestResult(null);
              setDraft((current) => ({ ...current, baseUrl: event.target.value }));
            }}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor={secretId} className="text-xs font-medium text-foreground">
            {secretLabel}
          </label>
          <div className="flex items-center gap-1.5">
            <SecretSourceInput
              key={secretInputKey}
              id={secretId}
              aria-label={secretLabel}
              className="min-w-0 flex-1"
              environmentId={environmentId}
              sources={sources}
              configured={isSavedLiteral}
              value={secretInputValue}
              placeholder={gt("Paste token or select a secret provider")}
              onValidityChange={(valid) => {
                setSecretValid(valid);
                setTestResult(null);
              }}
              onChange={(event) => {
                const value = event.target.value;
                setTestResult(null);
                setDraft((current) => ({
                  ...current,
                  secret: value
                    ? { kind: "new", value }
                    : !secretCleared && savedOriginal !== undefined
                      ? { kind: "saved", original: savedOriginal }
                      : { kind: "cleared" },
                }));
              }}
              onSecretChange={(ref) => {
                setTestResult(null);
                if (!ref) setSecretCleared(true);
                setDraft((current) => ({
                  ...current,
                  secret: ref ? { kind: "new", value: ref } : { kind: "cleared" },
                }));
              }}
            />
            {draft.secret.kind !== "cleared" ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-destructive"
                aria-label={gt("Clear saved token")}
                onClick={() => {
                  setSecretCleared(true);
                  setDraft((current) => ({ ...current, secret: { kind: "cleared" } }));
                  setSecretValid(true);
                  setSecretInputKey((n) => n + 1);
                  setTestResult(null);
                }}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        {draft.kind === "home-assistant-bambu" ? (
          <>
            <div className="space-y-1">
              <label htmlFor={prefixId} className="text-xs font-medium text-foreground">
                {gt("Entity prefix (optional)")}
              </label>
              <Input
                id={prefixId}
                value={draft.entityPrefix}
                placeholder="p1s_01p00a000000000"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, entityPrefix: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={deviceIdField} className="text-xs font-medium text-foreground">
                {gt("HA device ID (optional)")}
              </label>
              <Input
                id={deviceIdField}
                value={draft.deviceId}
                placeholder={gt("Auto-detected on test")}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, deviceId: event.target.value }))
                }
              />
            </div>
          </>
        ) : (
          <div className="space-y-1 sm:col-span-2">
            <label htmlFor={webcamId} className="text-xs font-medium text-foreground">
              {gt("Webcam snapshot URL (optional)")}
            </label>
            <Input
              id={webcamId}
              value={draft.webcamUrl}
              placeholder="http://printer.local/webcam/?action=snapshot"
              onChange={(event) =>
                setDraft((current) => ({ ...current, webcamUrl: event.target.value }))
              }
            />
          </div>
        )}
      </div>

      {testResult ? (
        <div
          className={
            testResult.ok
              ? "flex items-center gap-2 rounded-md border border-border bg-success/10 px-2.5 py-2 text-xs text-success-foreground"
              : "flex items-center gap-2 rounded-md border border-border bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          }
        >
          {testResult.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : null}
          <span>{testResult.summary}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!canTest || testing || !secretValid || !draft.baseUrl.trim()}
          onClick={() => void handleTest()}
        >
          {testing ? <Spinner /> : <Wrench className="size-3.5" />}
          {gt("Test connection")}
        </Button>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {gt("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={
              disabled || saving || !secretValid || !draft.baseUrl.trim() || !draft.label.trim()
            }
            onClick={() => void handleSubmit()}
          >
            {saving ? <Spinner /> : null}
            {gt("Save printer")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PrinterSettingsContent() {
  const gt = useGT();
  const { environment, search, selectScope } = useSettingsScope();
  const settings = useScopedSettings();
  const environmentId = environment?.environmentId ?? null;
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state } = usePrinterState(environmentId);
  const { entries: fleetPrinters } = useFleetPrinters(environmentId);
  const remotePrinters = fleetPrinters.filter((entry) => entry.isProxied);
  const configure = useAtomCommand(printerEnvironment.configure, { reportFailure: false });

  const [editingDraft, setEditingDraft] = useState<PrinterDraft | null>(null);
  const [removingPrinter, setRemovingPrinter] = useState<PrinterConfig | null>(null);
  const [pending, setPending] = useState(false);

  const printers = settings.printers;

  const applyConfigure = async (patch: {
    readonly enabled?: boolean;
    readonly agentAccessEnabled?: boolean;
    readonly printers?: ReadonlyArray<PrinterConfig>;
  }): Promise<boolean> => {
    if (!environmentId || !canConfigure) return false;
    setPending(true);
    let ok = false;
    try {
      const result = await configure({ environmentId, input: patch });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: gt("Could not save 3D printer settings"),
          description: formatEnvironmentQueryError(result.cause),
        });
      } else {
        ok = true;
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not save 3D printer settings"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setPending(false);
    return ok;
  };

  const handleSavePrinter = async (
    config: PrinterConfig,
    existingId?: PrinterId,
  ): Promise<boolean> => {
    const nextPrinters = existingId
      ? printers.map((entry) => (entry.id === existingId ? config : entry))
      : [...printers, config];
    const ok = await applyConfigure({
      enabled: true,
      printers: nextPrinters,
    });
    if (ok) {
      setEditingDraft(null);
    }
    return ok;
  };

  const handleRemovePrinter = async (id: PrinterId) => {
    const ok = await applyConfigure({
      printers: printers.filter((entry) => entry.id !== id),
    });
    if (ok && editingDraft?.existingId === id) {
      setEditingDraft(null);
    }
  };

  const openNewPrinterDraft = () => {
    setEditingDraft(
      emptyDraft(
        printers,
        printers.length === 0
          ? gt("3D Printer")
          : gt("3D Printer {number}", { number: printers.length + 1 }),
      ),
    );
  };

  return (
    <>
      <SettingsSection id="printers" title={gt("3D Printers")}>
        <SettingsRow
          id="printer-support"
          title={gt("Use 3D printers")}
          description={gt("Monitor live printer telemetry, cameras, and safe slicer controls.")}
          control={
            <Switch
              checked={settings.enablePrinterSupport}
              disabled={!environmentId || !canConfigure || pending}
              aria-label={gt("Use 3D printers")}
              onCheckedChange={(checked) => void applyConfigure({ enabled: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          id="agent-printer-access"
          title={gt("Agents can inspect 3D printers")}
          description={gt("Allow read-only status, live camera snapshots, and opening the panel.")}
          control={
            <Switch
              checked={settings.enableAgentPrinterAccess}
              disabled={
                !environmentId || !canConfigure || !settings.enablePrinterSupport || pending
              }
              aria-label={gt("Agents can inspect 3D printers")}
              onCheckedChange={(checked) =>
                void applyConfigure({ agentAccessEnabled: Boolean(checked) })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="printer-sources"
        title={gt("Configured printers")}
        headerAction={
          environmentId && canConfigure && !editingDraft ? (
            <Button size="sm" variant="outline" onClick={openNewPrinterDraft}>
              <Plus className="size-3.5" />
              {gt("Add printer")}
            </Button>
          ) : null
        }
      >
        <div className="space-y-3 p-4">
          {printers.length === 0 && !editingDraft ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-6 text-center">
              <Printer className="size-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {gt("No 3D printers added yet. Add a Bambu Lab, Moonraker, or OctoPrint host.")}
              </p>
              {environmentId && canConfigure ? (
                <Button size="sm" onClick={openNewPrinterDraft}>
                  <Plus className="size-3.5" />
                  {gt("Add printer")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {printers.map((printer) => {
            const live = state.printers.find((entry) => entry.id === printer.id);
            return (
              <div
                key={printer.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {printer.label}
                    </span>
                    <Badge
                      size="sm"
                      variant={
                        live?.online
                          ? "success"
                          : live?.connectionState === "error"
                            ? "error"
                            : "secondary"
                      }
                    >
                      {live?.online ? gt("Online") : gt("Offline")}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    <PrinterKindLabel kind={printer.kind} /> · {printer.baseUrl}
                    {live?.hardware.model ? ` · ${live.hardware.model}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!environmentId || !canConfigure || pending}
                    onClick={() => setEditingDraft(draftFromConfig(printer))}
                  >
                    {gt("Edit")}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!environmentId || !canConfigure || pending}
                    aria-label={gt("Remove {printer}", { printer: printer.label })}
                    onClick={() => setRemovingPrinter(printer)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}

          {editingDraft && environmentId ? (
            <PrinterEditorForm
              key={editingDraft.existingId ?? `new:${editingDraft.id}`}
              environmentId={environmentId}
              existingPrinters={printers}
              initialDraft={editingDraft}
              disabled={!canConfigure || pending}
              onSave={handleSavePrinter}
              onCancel={() => setEditingDraft(null)}
            />
          ) : null}
        </div>
      </SettingsSection>

      {remotePrinters.length > 0 ? (
        <SettingsSection id="printer-fleet-proxies" title={gt("Available via T3 Connect")}>
          <div className="space-y-2.5 p-4">
            <p className="text-xs text-muted-foreground">
              {gt(
                "Printers configured on another connected environment route automatically through it from any thread.",
              )}
            </p>
            {remotePrinters.map((entry) => (
              <div
                key={entry.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {entry.printer.label}
                    </span>
                    <Badge
                      size="sm"
                      variant={
                        entry.printer.online
                          ? "success"
                          : entry.printer.connectionState === "error"
                            ? "error"
                            : "secondary"
                      }
                    >
                      {entry.printer.online ? gt("Online") : gt("Offline")}
                    </Badge>
                    <Badge size="sm" variant="outline">
                      <Server className="size-2.5 shrink-0" />
                      {gt("Via {environment}", { environment: entry.proxyEnvironmentLabel })}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    <PrinterKindLabel kind={entry.printer.kind} />
                    {entry.printer.hardware.model ? ` · ${entry.printer.hardware.model}` : ""}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    selectScope(selectEnvironmentAxis(search, entry.proxyEnvironmentId))
                  }
                >
                  {gt("Manage on {environment}", { environment: entry.proxyEnvironmentLabel })}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <AlertDialog
        open={removingPrinter !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingPrinter(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Remove 3D printer?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt("Remove {printer} and its saved connection credentials from this environment.", {
                printer: removingPrinter?.label ?? gt("this printer"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{gt("Cancel")}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                const target = removingPrinter;
                setRemovingPrinter(null);
                if (target) void handleRemovePrinter(target.id);
              }}
            >
              {gt("Remove printer")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function PrintersSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <PrinterSettingsContent key={environment?.environmentId ?? "none"} />
    </SettingsPageContainer>
  );
}
