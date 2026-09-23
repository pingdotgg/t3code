import type { EnvironmentId, InstalledExtension } from "@t3tools/contracts";
import { PlayIcon, PuzzleIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import type { ExtensionSurfaceTarget } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { OpenVsxExtensionIcon } from "../settings/OpenVsxResultCard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { extensionHasUi, useExtensions } from "./useExtensions";

export interface ExtensionRuntimeProps {
  environmentId: EnvironmentId;
  target: ExtensionSurfaceTarget;
  extension: InstalledExtension;
  workspaceRoot?: string | undefined;
  onOpenWebview?: ((target: ExtensionSurfaceTarget) => void) | undefined;
}

export interface ExtensionSurfaceFrameProps {
  environmentId: EnvironmentId;
  target: ExtensionSurfaceTarget;
  workspaceRoot?: string | undefined;
  onOpenWebview?: ((target: ExtensionSurfaceTarget) => void) | undefined;
  onManage: () => void;
  onRunCommand?: ((command: string) => void) | undefined;
  children?: ((props: ExtensionRuntimeProps) => ReactNode) | undefined;
}

function FrameNotice(props: {
  icon?: ReactNode;
  title: string;
  description?: string | null | undefined;
  children?: ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">{props.icon ?? <PuzzleIcon />}</EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.children ? <EmptyContent>{props.children}</EmptyContent> : null}
    </Empty>
  );
}

function ExtensionInfo(props: {
  extension: InstalledExtension;
  iconUrl: string | null;
  onRunCommand: ((command: string) => void) | undefined;
}) {
  const { extension } = props;
  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="flex items-start gap-3">
          <OpenVsxExtensionIcon iconUrl={props.iconUrl} fallbackIcon={PuzzleIcon} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-medium">{extension.displayName}</h2>
              {extension.microsoftOnly ? (
                <Badge variant="warning" size="sm">
                  Microsoft-only: may not work
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {extension.publisher} · v{extension.version}
            </p>
            {extension.description ? (
              <p className="mt-2 text-sm text-muted-foreground">{extension.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Commands</h3>
          {extension.commands.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This extension has no panel and no commands. It works in the background.
            </p>
          ) : (
            <div className="flex flex-col">
              {extension.commands.map((command) => (
                <div
                  key={command.command}
                  className="flex items-center gap-3 border-t border-border/50 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {command.category ? `${command.category}: ${command.title}` : command.title}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {command.command}
                    </p>
                  </div>
                  {props.onRunCommand ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onRunCommand?.(command.command)}
                    >
                      <PlayIcon /> Run command
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExtensionSurfaceFrame(props: ExtensionSurfaceFrameProps) {
  const { state, error, resolveIconUrl } = useExtensions(props.environmentId);
  const setEnabled = useAtomCommand(serverEnvironment.setExtensionEnabled);
  const connect = useAtomCommand(serverEnvironment.connectExtensionHost);
  const host = state?.host;
  useEffect(() => {
    if (host === "notInstalled") void connect({ environmentId: props.environmentId, input: {} });
  }, [connect, host, props.environmentId]);
  const manage = (
    <Button size="sm" variant="outline" onClick={props.onManage}>
      Manage extensions
    </Button>
  );

  if (state === null) {
    if (error) return <FrameNotice title="Extensions are unavailable" description={error} />;
    return <FrameNotice icon={<Spinner size="md" />} title="Loading extension…" />;
  }

  const extension = state.extensions.find((entry) => entry.id === props.target.extensionId);
  if (!extension) {
    return (
      <FrameNotice
        title="This extension was removed"
        description="Install it again to use it in this panel."
      >
        {manage}
      </FrameNotice>
    );
  }
  if (!extension.enabled) {
    return (
      <FrameNotice
        title={`${extension.displayName} is disabled`}
        description="Enable it to use it in this panel."
      >
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              void setEnabled({
                environmentId: props.environmentId,
                input: { id: extension.id, enabled: true },
              })
            }
          >
            Enable
          </Button>
          {manage}
        </div>
      </FrameNotice>
    );
  }

  const hasUi = props.target.kind === "extension-webview" || extensionHasUi(extension);
  const info = (
    <ExtensionInfo
      extension={extension}
      iconUrl={resolveIconUrl(extension)}
      onRunCommand={props.onRunCommand}
    />
  );
  switch (state.host) {
    case "unsupported":
      return (
        <FrameNotice
          title="Extensions are not supported here"
          description={state.hostMessage ?? "This machine cannot run the extension host."}
        />
      );
    case "failed":
      return (
        <FrameNotice title="The extension host stopped" description={state.hostMessage}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void connect({ environmentId: props.environmentId, input: {} })}
          >
            Retry
          </Button>
        </FrameNotice>
      );
    case "ready":
      break;
    default:
      if (!hasUi) return info;
      return (
        <FrameNotice
          icon={<Spinner size="md" />}
          title={
            state.host === "downloading"
              ? "Downloading the extension host…"
              : "Starting the extension host…"
          }
          description={
            state.host === "downloading" ? "This happens once per environment." : undefined
          }
        />
      );
  }

  if (!hasUi || !props.children) return info;
  return (
    props.children({
      environmentId: props.environmentId,
      target: props.target,
      extension,
      workspaceRoot: props.workspaceRoot,
      onOpenWebview: props.onOpenWebview,
    }) ?? info
  );
}
