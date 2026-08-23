"use client";

import { CheckCircle2Icon, CopyIcon, DownloadIcon, KeyRoundIcon, TerminalIcon } from "lucide-react";
import { type ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderSetupGuideProps {
  readonly driverKind: ProviderDriverKind | null;
  readonly provider: ServerProvider | undefined;
}

export function ProviderSetupGuide({ driverKind, provider }: ProviderSetupGuideProps) {
  const [platformTab, setPlatformTab] = useState<"unix" | "win">("unix");

  const { copyToClipboard } = useCopyToClipboard<{ label: string }>({
    onCopy: ({ label }) => {
      toastManager.add({
        type: "success",
        title: "Copied to clipboard",
        description: `${label} command ready to paste in your terminal.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy command",
        description: error.message,
      });
    },
  });

  if (driverKind !== "antigravity") {
    return null;
  }

  const isInstalled = provider?.installed ?? false;
  const isAuth = provider?.auth.status === "authenticated";
  const authEmail = provider?.auth.email;

  const unixInstallCmd = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
  const winInstallCmd = "irm https://antigravity.google/cli/install.ps1 | iex";
  const authCmd = "agy";

  if (isInstalled && isAuth) {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs">
        <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="size-4 shrink-0" />
          <span>Antigravity CLI is installed and authenticated</span>
        </div>
        {authEmail ? (
          <p className="mt-1 text-muted-foreground">
            Signed in as <span className="font-mono text-foreground">{authEmail}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/80 bg-muted/30 p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-xs text-foreground">
          <TerminalIcon className="size-4 text-primary" />
          <span>Antigravity Setup & Authentication</span>
        </div>
      </div>

      {!isInstalled ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5 font-medium">
              <DownloadIcon className="size-3.5" /> Step 1: Install `agy` CLI
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPlatformTab("unix")}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  platformTab === "unix"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                macOS / Linux
              </button>
              <button
                type="button"
                onClick={() => setPlatformTab("win")}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  platformTab === "win"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Windows
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5 font-mono text-[11px]">
            <code className="flex-1 select-all overflow-x-auto text-foreground">
              {platformTab === "unix" ? unixInstallCmd : winInstallCmd}
            </code>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 shrink-0"
                    onClick={() =>
                      copyToClipboard(platformTab === "unix" ? unixInstallCmd : winInstallCmd, {
                        label: "Install",
                      })
                    }
                    aria-label="Copy install command"
                  >
                    <CopyIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Copy install command</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <span className="text-xs text-muted-foreground flex items-center gap-1.5 font-medium">
          <KeyRoundIcon className="size-3.5" />
          {isInstalled ? "Authenticate with Google" : "Step 2: Sign in with Google"}
        </span>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">agy</code> in
          your terminal and complete the Google login prompt in your browser:
        </p>
        <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5 font-mono text-[11px]">
          <code className="flex-1 select-all text-foreground">{authCmd}</code>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-6 shrink-0"
                  onClick={() => copyToClipboard(authCmd, { label: "Login" })}
                  aria-label="Copy login command"
                >
                  <CopyIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Copy login command</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
