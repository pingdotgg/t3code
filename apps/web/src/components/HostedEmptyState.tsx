import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { APP_DISPLAY_NAME, DESKTOP_DOWNLOAD_URL } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "../env";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { useRelayEnvironmentDiscovery } from "../state/environments";
import { CommandBlock } from "./CommandBlock";
import { useT3ConnectAuthPrompt } from "./clerk/useT3ConnectAuthPrompt";
import { CloudEnvironmentConnectRows } from "./cloud/CloudEnvironmentConnectList";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** Home screen for the hosted app before any computer is added. */
export function HostedEmptyState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>
              {localEnvironmentOff ? "This computer is off" : "No computer connected"}
            </EmptyTitle>
            <EmptyDescription>
              {localEnvironmentOff
                ? "Turn it back on, or connect a different computer."
                : cloudEnabled
                  ? "Your agents run on your computer."
                  : "Your agents run on your computer. Start T3 Code there first."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {localEnvironmentOff ? (
              <Button render={<Link to="/settings/connections" />} size="sm">
                Open Environments
              </Button>
            ) : (
              <ol className="w-full space-y-4 text-left">
                {cloudEnabled ? <T3ConnectSteps /> : <PairingSteps />}
              </ol>
            )}
          </EmptyContent>
        </Empty>
      </div>
    </SidebarInset>
  );
}

function T3ConnectSteps() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // Adding the first computer unmounts this screen. Wait for all health checks
  // so every compatible registration is queued before that happens.
  const [autoAddedComputers] = useState(() => new Set<EnvironmentId>());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const discovered = [...useRelayEnvironmentDiscovery().environments.values()];
  const discoverySettled =
    discovered.length > 0 && discovered.every(({ availability }) => availability !== "checking");
  return (
    <>
      <SetupStep number={1}>
        {isSignedIn ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CheckIcon className="size-4" />
            Signed in
          </p>
        ) : (
          <Button size="sm" disabled={!isLoaded} onClick={openAuthPrompt}>
            Sign in
          </Button>
        )}
      </SetupStep>
      <SetupStep number={2}>
        <RunOnComputer command="npx t3 connect" />
        {isSignedIn ? (
          <div className="mt-4 space-y-1.5">
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={null}
              savedEnvironments={[]}
              refreshWhileEmpty
              selection={{
                ...(discoverySettled ? { autoSelectedComputers: autoAddedComputers } : {}),
                selectedIds,
                onChange: (environmentId, selected) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (selected) next.add(environmentId);
                    else next.delete(environmentId);
                    return next;
                  }),
              }}
              empty={<p className="text-xs text-muted-foreground">Waiting for your computer…</p>}
            />
          </div>
        ) : null}
      </SetupStep>
    </>
  );
}

function PairingSteps() {
  return (
    <>
      <SetupStep number={1}>
        <RunOnComputer command="npx t3 pair" />
      </SetupStep>
      <SetupStep number={2}>
        <Button render={<Link to="/settings/connections" />} size="sm">
          Add pairing link
        </Button>
      </SetupStep>
    </>
  );
}

function SetupStep({
  number,
  children,
}: {
  readonly number: number;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="w-2 shrink-0 pt-1 text-muted-foreground">{number}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function RunOnComputer({ command }: { readonly command: string }) {
  return (
    <>
      <p>Run on your computer:</p>
      <CommandBlock command={command} className="mt-2" />
      <a
        className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        href={DESKTOP_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        Or download the desktop app
      </a>
    </>
  );
}
