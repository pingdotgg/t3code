import { useState } from "react";
import * as Option from "effect/Option";
import type { SshDeviceHostConfig } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, MonitorIcon, XIcon } from "lucide-react";
import { useT } from "../../hooks/useI18n";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { DeviceHostAvailability } from "../device/DeviceHostAvailability";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import {
  deviceHostConnectionKey,
  parseDeviceHostDraft,
  type DeviceHostCheckTarget,
} from "./deviceHostConnectionChecks";

export function DeviceHostEditor({
  host,
  isNew,
  targets,
  busy,
  onSave,
  onClose,
}: {
  host: SshDeviceHostConfig;
  isNew: boolean;
  targets: ReadonlyArray<DeviceHostCheckTarget>;
  busy: boolean;
  onSave: (host: SshDeviceHostConfig) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup showCloseButton={!busy}>
        <DeviceHostEditorForm
          host={host}
          isNew={isNew}
          targets={targets}
          busy={busy}
          onSave={onSave}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

function DeviceHostEditorForm({
  host,
  isNew,
  targets,
  busy,
  onSave,
  onClose,
}: {
  host: SshDeviceHostConfig;
  isNew: boolean;
  targets: ReadonlyArray<DeviceHostCheckTarget>;
  busy: boolean;
  onSave: (host: SshDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(host);
  const [expandedChecks, setExpandedChecks] = useState<{ key: string; open: boolean } | null>(null);
  const { checks, testConnection } = useHostConnectionChecks(targets);
  const connectionKey = deviceHostConnectionKey(draft);
  const results = checks[connectionKey];
  const checking = Object.values(results ?? {}).some((check) => check.status === "pending");
  const input = parseDeviceHostDraft({ ...draft, label: draft.label.trim() || draft.target });
  const valid = Option.isSome(input);
  const failed = Object.values(results ?? {}).filter((check) => check.status === "failed").length;
  const checksOpen =
    targets.length === 1 ||
    (expandedChecks?.key === connectionKey ? expandedChecks.open : failed > 0);
  const checkSummary = checking
    ? t("settings.code.deviceHost.checkingEnvironments")
    : results
      ? failed
        ? t("settings.code.deviceHost.someFailed", { failed, total: targets.length })
        : t("settings.code.deviceHost.checksPassed")
      : t("settings.code.deviceHost.checkBeforeSaving");
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (Option.isSome(input) && draft.label.trim() && !busy && !checking) onSave(input.value);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {isNew ? t("settings.code.deviceHost.addTitle") : t("settings.code.deviceHost.editTitle")}
        </DialogTitle>
        <DialogDescription>
          {targets.length === 1
            ? t("settings.code.deviceHost.descriptionOne", { name: targets[0]?.label ?? "" })
            : t("settings.code.deviceHost.descriptionMany", { count: targets.length })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label className="block space-y-1.5 text-sm">
          <span>{t("settings.code.deviceHost.name")}</span>
          <Input
            autoFocus
            required
            value={draft.label}
            disabled={busy}
            onChange={(event) => {
              const label = event.target.value;
              setDraft((current) => ({ ...current, label }));
            }}
            placeholder="Mac mini"
          />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span>{t("settings.code.deviceHost.sshTarget")}</span>
          <Input
            required
            value={draft.target}
            disabled={busy}
            onChange={(event) => {
              const target = event.target.value;
              setDraft((current) => ({ ...current, target }));
            }}
            placeholder={t("settings.code.deviceHost.sshTargetPlaceholder")}
          />
        </label>
        <details
          open={host.port !== undefined || host.identityFile !== undefined || undefined}
          className="text-sm"
        >
          <summary className="cursor-pointer text-muted-foreground">
            {t("settings.code.deviceHost.sshOptions")}
          </summary>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <label className="block space-y-1.5">
              <span>{t("settings.code.deviceHost.identityFile")}</span>
              <Input
                value={draft.identityFile ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const identityFile = event.target.value;
                  setDraft((current) => {
                    const { identityFile: _, ...rest } = current;
                    return identityFile ? { ...rest, identityFile } : rest;
                  });
                }}
                placeholder={t("settings.code.deviceHost.identityFilePlaceholder")}
              />
            </label>
            <label className="block space-y-1.5">
              <span>{t("settings.code.deviceHost.port")}</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={draft.port ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const port = event.target.value;
                  setDraft((current) => {
                    const { port: _, ...rest } = current;
                    return port ? { ...rest, port: Number(port) } : rest;
                  });
                }}
                placeholder={t("settings.code.deviceHost.portPlaceholder")}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings.code.deviceHost.optionalHint")}
          </p>
        </details>
        <Collapsible
          open={checksOpen}
          onOpenChange={(open) => setExpandedChecks({ key: connectionKey, open })}
          render={<div className="rounded-lg border border-border/60" />}
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            {targets.length === 1 ? (
              <p role="status" className="text-xs text-muted-foreground">
                {checkSummary}
              </p>
            ) : (
              <div className="min-w-0 text-xs [--inline-button-white-space:normal]">
                <CollapsibleTrigger
                  disabled={!results}
                  aria-label={t("settings.code.deviceHost.perMachineAria", {
                    summary: checkSummary,
                  })}
                  render={<InlineButton tone="muted" />}
                >
                  <span role="status" className="text-left">
                    {checkSummary}
                  </span>
                  {results ? (
                    <ChevronDownIcon
                      className={`size-3 shrink-0 ${checksOpen ? "rotate-180" : ""}`}
                    />
                  ) : null}
                </CollapsibleTrigger>
              </div>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || checking || !valid}
              onClick={() => {
                if (Option.isSome(input)) void testConnection(input.value);
              }}
            >
              {checking ? <Spinner size="xs" /> : null}{" "}
              {t("settings.code.deviceHost.testConnection")}
            </Button>
          </div>
          {results ? (
            <CollapsiblePanel
              render={<ul className="border-t border-border/60 divide-y divide-border/40" />}
            >
              {targets.map((target) => {
                const result = results[target.environmentId];
                if (!result) return null;
                return (
                  <li key={target.environmentId} className="px-3 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium">{target.label}</span>
                      <span
                        className={`flex shrink-0 items-center gap-1.5 ${result.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {result.status === "pending" ? (
                          <>
                            <Spinner size="xs" /> {t("settings.code.deviceHost.checking")}
                          </>
                        ) : result.status === "local" ? (
                          <>
                            <MonitorIcon className="size-3" />{" "}
                            {t("settings.code.deviceHost.availableLocally")}
                          </>
                        ) : result.status === "failed" ? (
                          <>
                            <XIcon className="size-3" /> {t("settings.code.deviceHost.failed")}
                          </>
                        ) : (
                          <>
                            <CheckIcon className="size-3" />{" "}
                            {t("settings.code.deviceHost.connected")}
                          </>
                        )}
                      </span>
                    </div>
                    {result.status === "connected" ? (
                      <div className="mt-1.5">
                        <DeviceHostAvailability platforms={result.platforms} />
                      </div>
                    ) : null}
                    {result.status === "failed" ? (
                      <details className="mt-1.5 text-muted-foreground">
                        <summary className="cursor-pointer">
                          {t("settings.code.deviceHost.showError")}
                        </summary>
                        <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                          {result.error}
                        </p>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </CollapsiblePanel>
          ) : null}
        </Collapsible>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {t("settings.code.deviceHost.cancel")}
        </Button>
        <Button type="submit" disabled={busy || checking || !valid || !draft.label.trim()}>
          {busy ? <Spinner size="xs" /> : null} {t("settings.code.deviceHost.saveHost")}
        </Button>
      </DialogFooter>
    </form>
  );
}
