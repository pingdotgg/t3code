import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { HouseIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadRouteView } from "../ThreadRouteView";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { homeFailure, type HomeFailure } from "./homeErrors";

/** Home lives on the primary environment: its coordinator thread, or the card that turns it on. */
export function HomePage() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? (
    <SidebarInset className="h-dvh" />
  ) : (
    <EnvironmentHome environmentId={environmentId} />
  );
}

function EnvironmentHome({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const home = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.home ?? null,
  );
  if (home?.enabled && home.threadId !== null) {
    return (
      <ThreadRouteView
        target={{ kind: "server", threadRef: scopeThreadRef(environmentId, home.threadId) }}
      />
    );
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <h1 className="truncate text-sm font-medium">
          <T>Home</T>
        </h1>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {home === null ? null : <HomeSetupCard environmentId={environmentId} />}
      </div>
    </SidebarInset>
  );
}

function HomeSetupCard({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const canEnable = useAtomValue(serverEnvironment.enableHome.permissionAtom(environmentId));
  const enable = useAtomCommand(serverEnvironment.enableHome, { label: "home enable" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HomeFailure | null>(null);
  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await enable({ environmentId, input: {} });
    setBusy(false);
    setFailure(homeFailure(result, m));
  };
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HouseIcon />
        </EmptyMedia>
        <EmptyTitle>
          <T>Home</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>
            One agent that works across your projects and linked environments. It starts threads,
            follows them, and keeps notes between conversations.
          </T>
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button disabled={!canEnable || busy} onClick={() => void turnOn()}>
          {busy ? gt("Turning on Home…") : gt("Enable Home")}
        </Button>
        {failure === null ? null : (
          <p className="text-sm text-destructive" role="alert">
            {failure.message}{" "}
            {failure.reason === "no-model" ? (
              <Link to="/settings/home" className="underline underline-offset-4">
                <T>Open Home settings</T>
              </Link>
            ) : null}
          </p>
        )}
      </EmptyContent>
    </Empty>
  );
}
