import { MonitorIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type {
  DesktopComputerUsePermission,
  DesktopComputerUsePermissionsState,
  DesktopComputerUsePrivacyPane,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { AgentCursorIcon, BraveIcon, ChromeIcon, EdgeIcon, FirefoxIcon } from "./browserBrandIcons";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

/** Shown when the desktop host lacks the Computer Use permissions bridge API. */
const BRIDGE_UNSUPPORTED_MESSAGE = "Update T3 Code to check Computer Use permissions";

function isDesktopHost(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

function isBridgeSupported(): boolean {
  return (
    typeof window !== "undefined" && window.desktopBridge?.getComputerUsePermissions !== undefined
  );
}

function RowTitle({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {icon}
      <span>{children}</span>
    </span>
  );
}

function ExtensionStatus({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "muted";
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "ok" && "bg-success",
          tone === "warn" && "bg-warning",
          tone === "muted" && "bg-muted-foreground/40",
        )}
        aria-hidden
      />
      <span>{children}</span>
    </span>
  );
}

function permissionTone(status: DesktopComputerUsePermission["status"]): "ok" | "warn" | "muted" {
  if (status === "granted" || status === "notRequired") return "ok";
  if (status === "denied" || status === "notDetermined") return "warn";
  return "muted";
}

function permissionLabel(status: DesktopComputerUsePermission["status"]): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "denied":
      return "Not granted";
    case "notDetermined":
      return "Not determined";
    case "notRequired":
      return "Not required on this platform";
    case "unknown":
      return "Unknown";
  }
}

export function ComputerUseSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const desktop = settings.desktopControl;
  const defaults = DEFAULT_UNIFIED_SETTINGS.desktopControl;
  const onDesktop = isDesktopHost();
  const [manageOpen, setManageOpen] = useState(false);
  const [moreBrowsersOpen, setMoreBrowsersOpen] = useState(false);
  const [permissionPrompt, setPermissionPrompt] = useState<DesktopComputerUsePermission | null>(
    null,
  );
  const [permState, setPermState] = useState<DesktopComputerUsePermissionsState | null>(null);
  const [permError, setPermError] = useState<string | null>(null);

  const refreshPermissions = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.getComputerUsePermissions) {
      setPermState(null);
      setPermError(BRIDGE_UNSUPPORTED_MESSAGE);
      return;
    }
    try {
      const next = await bridge.getComputerUsePermissions();
      setPermState(next);
      setPermError(null);
    } catch (error) {
      setPermError(error instanceof Error ? error.message : "Could not read permissions");
    }
  }, []);

  useEffect(() => {
    if (!onDesktop) return;
    const bridgeSupported = isBridgeSupported();
    if (!bridgeSupported) {
      setPermError(BRIDGE_UNSUPPORTED_MESSAGE);
      return;
    }
    void refreshPermissions();
    const onFocus = () => void refreshPermissions();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void refreshPermissions(), 4000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [onDesktop, refreshPermissions]);

  const openPrivacyPane = async (pane: DesktopComputerUsePrivacyPane) => {
    const bridge = window.desktopBridge;
    if (!bridge?.openComputerUsePrivacySettings) return;
    await bridge.openComputerUsePrivacySettings(pane);
    window.setTimeout(() => void refreshPermissions(), 1500);
  };

  const chromeStatus = permState?.chromeExtension;
  const needsMacPrivacy = permState?.platform === "darwin";
  const bridgeSupported = onDesktop && isBridgeSupported();

  return (
    <SettingsPageContainer>
      <SettingsSection id="computer-use" title="Computer Use">
        {!onDesktop ? (
          <div className="mb-1 flex items-start gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground sm:px-4">
            <MonitorIcon className="mt-0.5 size-4 shrink-0" />
            <p>
              You are connected to a remote environment. Computer Use settings apply on the host
              running the T3 Code desktop app.
            </p>
          </div>
        ) : null}

        <SettingsRow
          {...searchableSetting("computer-use-enabled")}
          description="Let T3 Code control apps on your computer"
          resetAction={
            desktop.enabled !== defaults.enabled ? (
              <SettingResetButton
                label="computer use"
                onClick={() =>
                  updateSettings({
                    desktopControl: { ...desktop, enabled: defaults.enabled },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={desktop.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  desktopControl: { ...desktop, enabled: Boolean(checked) },
                })
              }
              aria-label="Enable Computer Use"
            />
          }
        />

        <SettingsRow
          id={searchableSetting("computer-use-agent-cursor").id}
          title={
            <RowTitle icon={<AgentCursorIcon className="size-6" />}>
              {searchableSetting("computer-use-agent-cursor").title}
            </RowTitle>
          }
          description="Show the agent pointer overlay while it works, without moving your mouse."
          resetAction={
            desktop.agentCursorEnabled !== defaults.agentCursorEnabled ? (
              <SettingResetButton
                label="agent cursor"
                onClick={() =>
                  updateSettings({
                    desktopControl: {
                      ...desktop,
                      agentCursorEnabled: defaults.agentCursorEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={desktop.agentCursorEnabled}
              disabled={!desktop.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  desktopControl: {
                    ...desktop,
                    agentCursorEnabled: Boolean(checked),
                  },
                })
              }
              aria-label="Show agent cursor overlay"
            />
          }
        />

        <SettingsRow
          id={searchableSetting("computer-use-browser").id}
          title={
            <RowTitle icon={<ChromeIcon className="size-5" />}>
              {searchableSetting("computer-use-browser").title}
            </RowTitle>
          }
          description="Drive an agent-owned tab group in your signed-in Chrome."
          status={
            chromeStatus ? (
              <ExtensionStatus
                tone={
                  chromeStatus.status === "installed"
                    ? "ok"
                    : chromeStatus.status === "missing"
                      ? "warn"
                      : "muted"
                }
              >
                {chromeStatus.detail}
              </ExtensionStatus>
            ) : onDesktop ? (
              <ExtensionStatus tone="muted">
                {bridgeSupported ? "Checking extension…" : BRIDGE_UNSUPPORTED_MESSAGE}
              </ExtensionStatus>
            ) : null
          }
          resetAction={
            desktop.browserControlEnabled !== defaults.browserControlEnabled ? (
              <SettingResetButton
                label="browser control"
                onClick={() =>
                  updateSettings({
                    desktopControl: {
                      ...desktop,
                      browserControlEnabled: defaults.browserControlEnabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!desktop.enabled}
                onClick={() => setManageOpen(true)}
              >
                Manage
              </Button>
              <Switch
                checked={desktop.browserControlEnabled}
                disabled={!desktop.enabled}
                onCheckedChange={(checked) =>
                  updateSettings({
                    desktopControl: {
                      ...desktop,
                      browserControlEnabled: Boolean(checked),
                    },
                  })
                }
                aria-label="Enable Google Chrome browser control"
              />
            </div>
          }
        />

        <Collapsible open={moreBrowsersOpen} onOpenChange={setMoreBrowsersOpen}>
          <SettingsRow
            title={<RowTitle icon={<EdgeIcon className="size-5" />}>More browsers</RowTitle>}
            description="Set up the same extension in other Chromium browsers."
            control={
              <CollapsibleTrigger
                render={<Button type="button" variant="outline" size="sm" />}
                aria-controls="computer-use-more-browsers"
              >
                {moreBrowsersOpen ? "Hide" : "Show"}
              </CollapsibleTrigger>
            }
          >
            <CollapsibleContent id="computer-use-more-browsers">
              <div className="mt-2 space-y-3 rounded-xl bg-muted/20 px-3 py-3">
                <div className="flex items-center gap-3">
                  <EdgeIcon className="size-6" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Microsoft Edge</p>
                    <p className="text-[13px] text-muted-foreground">
                      Load the unpacked extension from edge://extensions
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <BraveIcon className="size-6" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Brave</p>
                    <p className="text-[13px] text-muted-foreground">
                      Same extension via brave://extensions
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 opacity-70">
                  <FirefoxIcon className="size-6" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Firefox</p>
                    <p className="text-[13px] text-muted-foreground">Not supported yet</p>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </SettingsRow>
        </Collapsible>
      </SettingsSection>

      {onDesktop ? (
        <SettingsSection title="Permissions">
          {(permState?.permissions ?? []).map((permission) => {
            const canOpen =
              needsMacPrivacy &&
              permission.status !== "granted" &&
              permission.status !== "notRequired";
            const search =
              permission.kind === "accessibility"
                ? searchableSetting("computer-use-accessibility")
                : searchableSetting("computer-use-screen-recording");
            return (
              <SettingsRow
                key={permission.kind}
                id={search.id}
                title={search.title}
                description={
                  permission.kind === "accessibility"
                    ? "Required to click and type in other apps."
                    : "Required for screenshots of apps and displays."
                }
                status={
                  <ExtensionStatus tone={permissionTone(permission.status)}>
                    {permissionLabel(permission.status)}
                  </ExtensionStatus>
                }
                control={
                  canOpen ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPermissionPrompt(permission)}
                    >
                      Open Settings
                    </Button>
                  ) : null
                }
              />
            );
          })}
          {permError ? <p className="px-3 text-sm text-destructive sm:px-4">{permError}</p> : null}
          {!permState && !permError ? (
            <p className="px-3 text-sm text-muted-foreground sm:px-4">Checking permissions…</p>
          ) : null}
          {needsMacPrivacy ? (
            <p className="px-3 text-[12px] leading-relaxed text-muted-foreground/80 sm:px-4">
              After enabling a permission in System Settings, return here — status refreshes
              automatically.
            </p>
          ) : null}
        </SettingsSection>
      ) : null}

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Google Chrome</DialogTitle>
            <DialogDescription>
              Load the T3 Code extension so agents can open and drive tabs in a labelled group
              without taking over your browsing.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-2 pl-4 text-foreground/90">
              <li>
                Open <span className="font-medium text-foreground">chrome://extensions</span> in
                Chrome and turn on Developer mode.
              </li>
              <li>
                Choose <span className="font-medium text-foreground">Load unpacked</span> and select
                the{" "}
                <span className="font-mono text-[12px] text-foreground">
                  native/t3-chrome-extension
                </span>{" "}
                folder from this repo (or the copy bundled with the desktop app).
              </li>
              <li>
                Confirm the extension id is{" "}
                <span className="font-mono text-[12px] text-foreground">
                  kgdolgnijopbghhomnblabjkmjhnoage
                </span>
                .
              </li>
            </ol>
            {chromeStatus ? (
              <ExtensionStatus
                tone={
                  chromeStatus.status === "installed"
                    ? "ok"
                    : chromeStatus.status === "missing"
                      ? "warn"
                      : "muted"
                }
              >
                {chromeStatus.detail}
              </ExtensionStatus>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={permissionPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPermissionPrompt(null);
        }}
      >
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Allow {permissionPrompt?.label ?? "permission"}</DialogTitle>
            <DialogDescription>
              T3 Code needs this macOS privacy permission for Computer Use. System Settings will
              open to the right Privacy &amp; Security list — turn on the switch for T3 Code.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="text-sm text-muted-foreground">
            {permissionPrompt?.kind === "accessibility" ? (
              <p>
                Accessibility lets the agent click and type in other apps without stealing your
                mouse.
              </p>
            ) : (
              <p>Screen Recording lets the agent take screenshots of apps and displays.</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button
              type="button"
              onClick={() => {
                const pane = permissionPrompt?.kind;
                setPermissionPrompt(null);
                if (pane) void openPrivacyPane(pane);
              }}
            >
              Open System Settings
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
