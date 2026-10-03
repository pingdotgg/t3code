import type {
  EnvironmentId,
  ServerComputerAccessAction,
  ServerComputerAccessStatus,
} from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { PermissionChecklist } from "../permissions/PermissionChecklist";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

export type ComputerAccessSetupKind = "apps" | "browser";

const ACTION_FAILURES: Record<ServerComputerAccessAction, string> = {
  "install-cua-driver": "Cua Driver did not install. Try again, or install it from cua.ai.",
  "request-cua-permissions": "Could not ask macOS for permissions. Try again.",
  "cancel-cua-permissions": "Could not stop the permission request.",
  "open-accessibility-settings": "System Settings did not open. Open Privacy & Security yourself.",
  "open-screen-recording-settings":
    "System Settings did not open. Open Privacy & Security yourself.",
  "install-browser-tool":
    "Chrome DevTools MCP did not install. It needs Node.js on the Mac that runs T3 Code.",
};

/** Whether agents can control apps: the driver is installed and macOS allows it. */
export function computerAppsReady(status: ServerComputerAccessStatus): boolean {
  const { path, permissions } = status.cuaDriver;
  return path !== null && permissions.accessibility && permissions.screenRecording;
}

/** The browser with remote debugging on, which agents attach to, if any. */
function debuggableBrowser(status: ServerComputerAccessStatus) {
  return status.browsers.find((browser) => browser.remoteDebugging);
}

/** The browser agents attach to, or undefined until setup has finished on this Mac. */
export function computerBrowserReady(status: ServerComputerAccessStatus) {
  return status.browserToolInstalled ? debuggableBrowser(status) : undefined;
}

/**
 * Setup for one computer access switch. Each step acts on the selected
 * environment's Mac, which is the one the agents drive; `hostLabel` names it,
 * since a remote user cannot click the prompts that appear there. Finishing
 * turns the switch on; closing early leaves it off.
 */
export function ComputerAccessSetupDialog({
  kind,
  environmentId,
  hostLabel,
  status,
  statusError,
  onRefresh,
  onFinish,
  onClose,
}: {
  kind: ComputerAccessSetupKind;
  environmentId: EnvironmentId;
  hostLabel: string;
  status: ServerComputerAccessStatus | null;
  /** Set when the status check failed, so setup offers a retry instead of loading forever. */
  statusError: string | null;
  onRefresh: () => void;
  onFinish: () => void;
  onClose: () => void;
}) {
  const run = useAtomCommand(serverEnvironment.runComputerAccessAction, { reportFailure: false });
  const [pending, setPending] = useState<ServerComputerAccessAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;
  const requesting = status?.cuaDriver.requestingPermissions ?? false;

  // The user grants access in System Settings or the browser, then comes back.
  // While Cua waits on the user, status is also polled.
  const refreshLatest = useEffectEvent(() => {
    if (!busy) onRefresh();
  });
  useEffect(() => {
    const refresh = () => refreshLatest();
    window.addEventListener("focus", refresh);
    const timer = requesting ? window.setInterval(refresh, 2000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [requesting]);

  // Whether this dialog started a permission request. Set as soon as Start is
  // pressed, since the status that reports the request can arrive after the
  // dialog closes.
  const requestStarted = useRef(false);
  const runAction = async (action: ServerComputerAccessAction) => {
    if (action === "request-cua-permissions") requestStarted.current = true;
    setPending(action);
    setError(null);
    const result = await run({ environmentId, input: { action } });
    setPending(null);
    if (result._tag === "Failure") setError(ACTION_FAILURES[action]);
    onRefresh();
    return result._tag !== "Failure";
  };
  // A request left running would keep waiting on the user for minutes, so the
  // dialog cancels its own request when it closes for any reason. Another
  // client's request is left alone.
  const cancelRequest = useEffectEvent(() => {
    if (requestStarted.current) {
      void run({ environmentId, input: { action: "cancel-cua-permissions" } });
    }
  });
  useEffect(() => () => cancelRequest(), []);
  const close = onClose;
  // Installed here, not by a status check, so polling never waits on npm.
  const finishBrowser = async () => {
    if (status?.browserToolInstalled || (await runAction("install-browser-tool"))) onFinish();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        {status === null && statusError !== null ? (
          <>
            <WizardHeader
              title={kind === "apps" ? "Set up computer access" : "Use your browser tabs"}
            />
            <WizardPanel>
              <p role="alert" className="text-sm text-destructive">
                Could not check {hostLabel}. Make sure T3 Code is running there, then try again.
              </p>
            </WizardPanel>
            <WizardFooter>
              <Button variant="ghost" onClick={close}>
                Finish later
              </Button>
              <Button onClick={onRefresh}>Check again</Button>
            </WizardFooter>
          </>
        ) : kind === "apps" ? (
          <AppsSetup
            hostLabel={hostLabel}
            status={status}
            pending={pending}
            error={error}
            onAction={(action) => void runAction(action)}
            onFinish={onFinish}
            onClose={close}
          />
        ) : (
          <BrowserSetup
            hostLabel={hostLabel}
            status={status}
            installing={pending === "install-browser-tool"}
            error={error}
            onRefresh={onRefresh}
            onFinish={() => void finishBrowser()}
            onClose={close}
          />
        )}
      </WizardPopup>
    </Dialog>
  );
}

function AppsSetup({
  hostLabel,
  status,
  pending,
  error,
  onAction,
  onFinish,
  onClose,
}: {
  hostLabel: string;
  status: ServerComputerAccessStatus | null;
  pending: ServerComputerAccessAction | null;
  error: string | null;
  onAction: (action: ServerComputerAccessAction) => void;
  onFinish: () => void;
  onClose: () => void;
}) {
  const driver = status?.cuaDriver;
  const installed = Boolean(driver?.path);
  const permissions = driver?.permissions;
  const [stepChoice, setStepChoice] = useState<number | null>(null);
  // Open on the first step that still needs the user, until they pick one.
  const step = stepChoice ?? (installed ? 1 : 0);
  const loading = status === null;
  const busy = pending !== null || loading;
  const ready = status !== null && computerAppsReady(status);
  const requesting = driver?.requestingPermissions ?? false;

  return (
    <>
      <WizardHeader title="Set up computer access">
        <WizardSteps
          steps={["Install", "Permissions"]}
          currentStep={step}
          isStepDisabled={(index) => busy || (index === 1 && !installed)}
          onStepChange={setStepChoice}
        />
      </WizardHeader>
      <WizardPanel>
        <div className="space-y-4 text-sm">
          {step === 0 ? (
            <div className="space-y-2" aria-live="polite">
              <h3 className="font-medium">
                {loading
                  ? `Checking ${hostLabel}…`
                  : installed
                    ? "Cua Driver is installed"
                    : "Install Cua Driver"}
              </h3>
              <DialogDescription>
                Cua Driver lets agents use apps on {hostLabel} in the background, without moving the
                cursor. It is open source and made by Cua.
              </DialogDescription>
              {installed ? (
                <p className="break-all font-mono text-xs text-muted-foreground">{driver?.path}</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3" aria-live="polite">
              <div className="space-y-2">
                <h3 className="font-medium">
                  {ready ? "Cua Driver has both permissions" : "Allow Cua Driver"}
                </h3>
                {ready ? null : (
                  <DialogDescription>
                    {requesting
                      ? `Turn on CuaDriver in both lists in System Settings on ${hostLabel}. Allow opens each list there. If CuaDriver is not in Screen & System Audio Recording, click + and add it from Applications. If macOS asks to let it capture without the picker, choose Allow.`
                      : "Start shows the macOS prompts. Cua Driver checks both permissions once they are allowed."}
                  </DialogDescription>
                )}
              </div>
              {/* Cua only reports grants once it has verified both, so each
                  row opens its System Settings list instead of guessing. */}
              <PermissionChecklist
                busy={busy}
                permissions={[
                  {
                    id: "accessibility",
                    icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                    title: "Accessibility",
                    description: "Click, type, and read app controls.",
                    granted: permissions?.accessibility ?? false,
                    onAllow: () => onAction("open-accessibility-settings"),
                  },
                  {
                    id: "screenRecording",
                    icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                    title: "Screen & System Audio Recording",
                    description: "See the app windows it works in.",
                    granted: permissions?.screenRecording ?? false,
                    onAllow: () => onAction("open-screen-recording-settings"),
                  },
                ]}
              />
              {ready ? null : (
                <p className="text-xs text-muted-foreground">
                  These prompts appear on {hostLabel}. If you are not at that Mac, someone there has
                  to approve them.
                </p>
              )}
              {driver?.permissionsFailed && !requesting && !ready ? (
                <p role="alert" className="text-xs text-destructive">
                  Cua Driver did not get both permissions. Turn on CuaDriver in both lists in System
                  Settings, then try again.
                </p>
              ) : null}
            </div>
          )}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </WizardPanel>
      <WizardFooter>
        <Button variant="ghost" disabled={pending !== null} onClick={onClose}>
          Finish later
        </Button>
        {step === 0 && !installed ? (
          <Button disabled={busy} aria-busy={busy} onClick={() => onAction("install-cua-driver")}>
            {pending === "install-cua-driver" ? "Installing…" : "Install"}
          </Button>
        ) : step === 0 ? (
          <Button disabled={busy} onClick={() => setStepChoice(1)}>
            Continue
          </Button>
        ) : ready ? (
          <Button disabled={busy} onClick={onFinish}>
            Done
          </Button>
        ) : requesting ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onAction("request-cua-permissions")}
            >
              Restart
            </Button>
            <Button disabled aria-busy>
              Waiting for you…
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={() => onAction("request-cua-permissions")}>
            {driver?.permissionsFailed ? "Try again" : "Start"}
          </Button>
        )}
      </WizardFooter>
    </>
  );
}

function BrowserSetup({
  hostLabel,
  status,
  installing,
  error,
  onRefresh,
  onFinish,
  onClose,
}: {
  hostLabel: string;
  status: ServerComputerAccessStatus | null;
  installing: boolean;
  error: string | null;
  onRefresh: () => void;
  onFinish: () => void;
  onClose: () => void;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // Only a successful copy marks its link as copied.
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({ onCopy: setCopiedUrl });
  const browsers = status?.browsers ?? [];
  const ready = status !== null && debuggableBrowser(status) !== undefined;

  return (
    <>
      <WizardHeader title="Use your browser tabs" />
      <WizardPanel>
        <div className="space-y-4 text-sm">
          <div className="space-y-2" aria-live="polite">
            <h3 className="font-medium">Turn on remote debugging</h3>
            <DialogDescription>
              Agents connect to the browser on {hostLabel} that has remote debugging on. On that
              Mac, open the browser's page below and check Allow remote debugging. The browser asks
              to allow each connection, so someone at that Mac has to approve it.
            </DialogDescription>
          </div>
          {status !== null && browsers.length === 0 ? (
            <p className="text-muted-foreground">
              No Chromium browser found. Install Chrome, Helium, Brave, or Edge.
            </p>
          ) : (
            <div className="space-y-2">
              {browsers.map((browser) => (
                <div
                  key={browser.id}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{browser.name}</p>
                    {browser.remoteDebugging ? null : (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {browser.inspectUrl}
                      </p>
                    )}
                  </div>
                  {browser.remoteDebugging ? (
                    <span role="status" className="flex items-center gap-1 text-xs text-success">
                      <CircleCheckIcon className="size-4" aria-hidden="true" />
                      On
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        copyToClipboard(browser.inspectUrl, browser.inspectUrl);
                      }}
                    >
                      {isCopied && copiedUrl === browser.inspectUrl ? "Copied" : "Copy link"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </WizardPanel>
      <WizardFooter>
        <Button variant="ghost" disabled={installing} onClick={onClose}>
          Finish later
        </Button>
        <Button variant="outline" disabled={installing} onClick={onRefresh}>
          Check again
        </Button>
        <Button disabled={!ready || installing} aria-busy={installing} onClick={onFinish}>
          {installing ? "Installing…" : "Done"}
        </Button>
      </WizardFooter>
    </>
  );
}
