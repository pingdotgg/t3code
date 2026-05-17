"use client";

import {
  type AcpRegistryDistributionKind,
  AcpRegistrySettings,
  acpRegistryDriverKindFor,
  type AcpRegistryEntryWithStatus,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DownloadIcon,
  ExternalLinkIcon,
  PackageIcon,
  PlusCircleIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AcpRegistryIcon } from "../AcpRegistryIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { Icon } from "../Icons";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  ProviderSettingsForm,
  deriveProviderSettingsFields,
  type ProviderSettingsFieldModel,
} from "./ProviderSettingsForm";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS, type DriverOption } from "./providerDriverMeta";

const REGISTRY_DOCS_URL = "https://agentclientprotocol.com/get-started/registry";

const DISTRIBUTION_LABEL: Record<AcpRegistryDistributionKind, string> = {
  binary: "Binary",
  npx: "npx",
  uvx: "uvx",
};

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function makeAcpRegistryIconComponent(agentId: string): Icon {
  return function AcpRegistryAgentIcon({ className }) {
    return <AcpRegistryIcon agentId={agentId} className={className ?? ""} />;
  };
}

function toDriverOption(entry: AcpRegistryEntryWithStatus): DriverOption {
  return {
    value: ProviderDriverKind.make(acpRegistryDriverKindFor(entry.entry.id)),
    label: entry.entry.name,
    icon: makeAcpRegistryIconComponent(entry.entry.id),
    settingsSchema: AcpRegistrySettings,
    badgeLabel: "ACP",
  };
}

type PanelMode =
  | { kind: "browse" }
  | {
      kind: "configure";
      driverOption: DriverOption;
      isFromAcpRegistry: boolean;
    };

interface AddOrInstallProviderPanelProps {
  anchorId?: string;
}

export function AddOrInstallProviderPanel({
  anchorId = "providers-add-or-install",
}: AddOrInstallProviderPanelProps) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const listAcpRegistry = useAtomCommand(serverEnvironment.listAcpRegistry, {
    reportFailure: false,
  });
  const installAcpRegistryAgent = useAtomCommand(serverEnvironment.installAcpRegistryAgent, {
    reportFailure: false,
  });
  const uninstallAcpRegistryAgent = useAtomCommand(serverEnvironment.uninstallAcpRegistryAgent, {
    reportFailure: false,
  });

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PanelMode>({ kind: "browse" });

  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [instanceIdInput, setInstanceIdInput] = useState("");
  const [instanceIdDirty, setInstanceIdDirty] = useState(false);
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const [acpEntries, setAcpEntries] = useState<ReadonlyArray<AcpRegistryEntryWithStatus>>([]);
  const [acpLoading, setAcpLoading] = useState(true);
  const [acpError, setAcpError] = useState<string | null>(null);
  const [busyAcpIds, setBusyAcpIds] = useState<ReadonlySet<string>>(() => new Set());
  const [uninstallConfirmEntry, setUninstallConfirmEntry] =
    useState<AcpRegistryEntryWithStatus | null>(null);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const refreshAcp = useCallback(async () => {
    if (!primaryEnvironment) {
      setAcpError("Connect to a backend to load the ACP registry.");
      setAcpLoading(false);
      return;
    }
    try {
      const result = await listAcpRegistry({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      });
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      setAcpEntries(result.value);
      setAcpError(null);
    } catch (cause) {
      setAcpError(describeError(cause, "Failed to load ACP registry."));
    } finally {
      setAcpLoading(false);
    }
  }, [listAcpRegistry, primaryEnvironment]);

  useEffect(() => {
    void refreshAcp();
  }, [refreshAcp]);

  useEffect(() => {
    if (mode.kind !== "configure") return;
    setLabel("");
    setAccentColor("");
    setInstanceIdInput(deriveInstanceId(mode.driverOption.value, ""));
    setInstanceIdDirty(false);
    setConfigDraft({});
    setHasAttemptedSubmit(false);
  }, [mode]);

  useEffect(() => {
    if (mode.kind !== "configure") return;
    if (instanceIdDirty) return;
    setInstanceIdInput(deriveInstanceId(mode.driverOption.value, label));
  }, [label, instanceIdDirty, mode]);

  const acpDriverOptions = useMemo(
    () =>
      acpEntries
        .filter((entry) => entry.status === "installed" || entry.status === "update_available")
        .map(toDriverOption),
    [acpEntries],
  );

  const acpDriverOptionByValue = useMemo(
    () => new Map(acpDriverOptions.map((option) => [option.value, option] as const)),
    [acpDriverOptions],
  );

  const matchesQuery = useCallback(
    (text: string): boolean => {
      if (!query.trim()) return true;
      return text.toLowerCase().includes(query.trim().toLowerCase());
    },
    [query],
  );

  const filteredBuiltIns = useMemo(
    () => DRIVER_OPTIONS.filter((option) => matchesQuery(option.label)),
    [matchesQuery],
  );

  const filteredAcp = useMemo(
    () =>
      acpEntries.filter((entry) =>
        matchesQuery(`${entry.entry.name} ${entry.entry.id} ${entry.entry.description}`),
      ),
    [acpEntries, matchesQuery],
  );

  const handleSelectBuiltIn = useCallback((option: DriverOption) => {
    setMode({ kind: "configure", driverOption: option, isFromAcpRegistry: false });
  }, []);

  const handleSelectInstalledAcp = useCallback(
    (entry: AcpRegistryEntryWithStatus) => {
      const option =
        acpDriverOptionByValue.get(
          ProviderDriverKind.make(acpRegistryDriverKindFor(entry.entry.id)),
        ) ?? toDriverOption(entry);
      setMode({ kind: "configure", driverOption: option, isFromAcpRegistry: true });
    },
    [acpDriverOptionByValue],
  );

  const runAcpAction = useCallback(
    async (agentId: string, name: string, action: "install" | "uninstall") => {
      setBusyAcpIds((prev) => new Set(prev).add(agentId));
      try {
        if (!primaryEnvironment) {
          throw new Error("Connect to a backend before changing ACP registry agents.");
        }
        const runAction =
          action === "install" ? installAcpRegistryAgent : uninstallAcpRegistryAgent;
        const result = await runAction({
          environmentId: primaryEnvironment.environmentId,
          input: { agentId },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `${name} ${action === "install" ? "installed" : "removed"}`,
          }),
        );
        await refreshAcp();
      } catch (cause) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to ${action} ${name}`,
            description: describeError(cause, String(cause)),
          }),
        );
      } finally {
        setBusyAcpIds((prev) => {
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [installAcpRegistryAgent, primaryEnvironment, refreshAcp, uninstallAcpRegistryAgent],
  );

  const handleInstall = useCallback(
    (entry: AcpRegistryEntryWithStatus) => {
      void runAcpAction(entry.entry.id, entry.entry.name, "install");
    },
    [runAcpAction],
  );

  const handleUninstall = useCallback((entry: AcpRegistryEntryWithStatus) => {
    setUninstallConfirmEntry(entry);
  }, []);

  const confirmUninstall = useCallback(() => {
    if (!uninstallConfirmEntry) return;
    void runAcpAction(
      uninstallConfirmEntry.entry.id,
      uninstallConfirmEntry.entry.name,
      "uninstall",
    );
    setUninstallConfirmEntry(null);
  }, [uninstallConfirmEntry, runAcpAction]);

  const configuringOption = mode.kind === "configure" ? mode.driverOption : null;
  const configuringFields = useMemo(
    () => (configuringOption ? deriveProviderSettingsFields(configuringOption) : []),
    [configuringOption],
  );
  const instanceIdError =
    mode.kind === "configure" ? validateInstanceId(instanceIdInput, existingIds) : null;
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;

  const handleSave = useCallback(() => {
    if (mode.kind !== "configure") return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;

    const hasConfig = Object.keys(configDraft).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver: mode.driverOption.value,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config: configDraft } : {}),
    };

    try {
      const brandedId = ProviderInstanceId.make(instanceIdInput);
      updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [brandedId]: nextInstance,
        },
      });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${mode.driverOption.label} instance '${instanceIdInput}' was added.`,
      });
      setMode({ kind: "browse" });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: describeError(cause, "Update failed."),
      });
    }
  }, [
    accentColor,
    configDraft,
    instanceIdError,
    instanceIdInput,
    label,
    mode,
    settings.providerInstances,
    updateSettings,
  ]);

  return (
    <div
      id={anchorId}
      data-providers-add-or-install="true"
      className="rounded-lg border border-border bg-card"
    >
      <Header />
      <Toolbar query={query} setQuery={setQuery} />

      <AnimatedHeight>
        {mode.kind === "browse" ? (
          <div className="space-y-4 px-4 pb-4">
            <TileGroup title="Built-in drivers">
              {filteredBuiltIns.map((option) => (
                <DriverTile
                  key={option.value}
                  option={option}
                  onClick={() => handleSelectBuiltIn(option)}
                />
              ))}
            </TileGroup>

            <TileGroup
              title="ACP Registry"
              actionRight={
                <a
                  href={REGISTRY_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Learn more
                  <ExternalLinkIcon className="size-3" />
                </a>
              }
            >
              {acpLoading ? (
                <div className="col-span-full flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Loading registry…
                </div>
              ) : acpError ? (
                <div className="col-span-full rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  {acpError}
                </div>
              ) : filteredAcp.length === 0 ? (
                <div className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  {query ? "No agents match your search." : "No agents available."}
                </div>
              ) : (
                filteredAcp.map((entry) => (
                  <AcpRegistryTile
                    key={entry.entry.id}
                    entry={entry}
                    busy={busyAcpIds.has(entry.entry.id)}
                    onInstall={() => handleInstall(entry)}
                    onUninstall={() => handleUninstall(entry)}
                    onAddInstance={() => handleSelectInstalledAcp(entry)}
                  />
                ))
              )}
            </TileGroup>
          </div>
        ) : (
          <ConfigureForm
            mode={mode}
            label={label}
            setLabel={setLabel}
            accentColor={accentColor}
            setAccentColor={setAccentColor}
            instanceIdInput={instanceIdInput}
            setInstanceIdInput={(value) => {
              setInstanceIdDirty(true);
              setInstanceIdInput(value);
            }}
            showInstanceIdError={showInstanceIdError}
            instanceIdError={instanceIdError}
            configDraft={configDraft}
            setConfigDraft={(draft) => setConfigDraft(draft ?? {})}
            configuringFields={configuringFields}
            onCancel={() => setMode({ kind: "browse" })}
            onSave={handleSave}
          />
        )}
      </AnimatedHeight>

      {uninstallConfirmEntry && (
        <AlertDialog
          open={!!uninstallConfirmEntry}
          onOpenChange={(open) => !open && setUninstallConfirmEntry(null)}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {uninstallConfirmEntry.entry.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the agent and delete all associated provider instances. This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button variant="destructive" onClick={confirmUninstall}>
                Remove
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-medium text-foreground">Add or install a provider</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Pick a built-in driver to configure a new instance, or install an ACP-conforming agent —
        installed agents register as providers automatically.
      </p>
    </div>
  );
}

function Toolbar({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search drivers & agents…"
          className="pl-8"
        />
      </div>
    </div>
  );
}

function TileGroup({
  title,
  actionRight,
  children,
}: {
  title: string;
  actionRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {actionRight}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function DriverTile({ option, onClick }: { option: DriverOption; onClick: () => void }) {
  const IconComponent = option.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left transition",
        "hover:border-foreground/25 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
    >
      <IconComponent className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {option.label}
      </span>
      {option.badgeLabel ? (
        <Badge variant="warning" size="sm">
          {option.badgeLabel}
        </Badge>
      ) : null}
      <PlusCircleIcon
        aria-hidden
        className="size-4 text-muted-foreground/60 group-hover:text-foreground"
      />
    </button>
  );
}

function AcpRegistryTile({
  entry,
  busy,
  onInstall,
  onUninstall,
  onAddInstance,
}: {
  entry: AcpRegistryEntryWithStatus;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onAddInstance: () => void;
}) {
  const { entry: meta, status, installed, availableChannels } = entry;
  const isUnsupported = status === "unsupported";
  const isInstalled = status === "installed" || status === "update_available";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/30">
          <AcpRegistryIcon agentId={meta.id} className="size-5 opacity-80" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h5 className="truncate text-sm font-medium text-foreground">{meta.name}</h5>
            <span className="shrink-0 text-[11px] text-muted-foreground">v{meta.version}</span>
            {status === "update_available" && installed && (
              <Badge variant="outline" size="sm" className="px-1 py-0 text-[9px]">
                Update v{installed.version}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
            {meta.description}
          </p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/80">
            <span className="font-mono">{meta.id}</span>
            {!isUnsupported && availableChannels.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <PackageIcon className="size-2.5" />
                {availableChannels.map((channel) => DISTRIBUTION_LABEL[channel]).join(" · ")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5">
        {isUnsupported ? (
          <Badge variant="outline" size="sm" className="text-muted-foreground">
            Unsupported on this platform
          </Badge>
        ) : isInstalled ? (
          <>
            <Button size="sm" variant="ghost" onClick={onAddInstance} className="gap-1.5">
              <PlusCircleIcon className="size-3.5" />
              Add instance
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onUninstall}
              disabled={busy}
              className="gap-1.5"
            >
              {busy ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
              Remove
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onInstall} disabled={busy} className="gap-1.5">
            {busy ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
            Install
          </Button>
        )}
      </div>
    </div>
  );
}

interface ConfigureFormProps {
  mode: Extract<PanelMode, { kind: "configure" }>;
  label: string;
  setLabel: (value: string) => void;
  accentColor: string;
  setAccentColor: (value: string) => void;
  instanceIdInput: string;
  setInstanceIdInput: (value: string) => void;
  showInstanceIdError: boolean;
  instanceIdError: string | null;
  configDraft: Record<string, unknown>;
  setConfigDraft: (value: Record<string, unknown> | undefined) => void;
  configuringFields: ReadonlyArray<ProviderSettingsFieldModel>;
  onCancel: () => void;
  onSave: () => void;
}

function ConfigureForm(props: ConfigureFormProps) {
  const { mode } = props;
  const DriverIcon = mode.driverOption.icon;

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <DriverIcon className="size-5 shrink-0" aria-hidden />
        <span className="text-sm font-medium text-foreground">{mode.driverOption.label}</span>
        {mode.driverOption.badgeLabel ? (
          <Badge variant="warning" size="sm">
            {mode.driverOption.badgeLabel}
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={props.onCancel}
          className="ml-auto text-xs text-muted-foreground"
        >
          Change driver
        </Button>
      </div>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Label</span>
        <Input
          className="bg-background"
          placeholder="e.g. Work"
          value={props.label}
          onChange={(event) => props.setLabel(event.target.value)}
        />
        <span className="text-[11px] text-muted-foreground">
          Shown in the provider list. Optional.
        </span>
      </label>

      <label className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Instance ID</span>
        <Input
          className="bg-background"
          placeholder={`${mode.driverOption.value}_work`}
          value={props.instanceIdInput}
          onChange={(event) => props.setInstanceIdInput(event.target.value)}
          aria-invalid={props.showInstanceIdError}
        />
        {props.showInstanceIdError ? (
          <span className="text-[11px] text-destructive">{props.instanceIdError}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Routing key used by threads and sessions. Letters, digits, '-', or '_'.
          </span>
        )}
      </label>

      <div className="grid gap-2">
        <span className="text-xs font-medium text-foreground">Accent color</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            type="color"
            value={normalizeProviderAccentColor(props.accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
            onChange={(event) => props.setAccentColor(event.target.value)}
            aria-label="Provider instance accent color"
            className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
          />
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
              const selected = props.accentColor.toLowerCase() === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  className={cn(
                    "size-6 cursor-pointer rounded-full border transition",
                    selected
                      ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                      : "border-black/10 hover:scale-105 dark:border-white/20",
                  )}
                  style={{ backgroundColor: swatch }}
                  onClick={() => props.setAccentColor(swatch)}
                  aria-label={`Use ${swatch} accent`}
                />
              );
            })}
          </div>
          {props.accentColor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => props.setAccentColor("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <span className="text-[11px] text-muted-foreground">
          Optional marker shown in the picker.
        </span>
      </div>

      {props.configuringFields.length > 0 ? (
        <div className="grid gap-4">
          <ProviderSettingsForm
            definition={mode.driverOption}
            value={props.configDraft}
            idPrefix={`add-provider-${mode.driverOption.value}`}
            variant="dialog"
            onChange={props.setConfigDraft}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This driver has no required configuration. You can add the instance now.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={props.onSave}>
          Add instance
        </Button>
      </div>
    </div>
  );
}

export { DRIVER_OPTION_BY_VALUE };
