import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, DownloadIcon, ShareIcon, SmartphoneIcon } from "lucide-react";

import { Button } from "../ui/button";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) && !("MSStream" in window);
}

type InstallLandingCardProps = {
  hasToken: boolean;
  onTryOpenApp?: () => void;
};

export function InstallLandingCard({ hasToken, onTryOpenApp }: InstallLandingCardProps) {
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installStatus, setInstallStatus] = useState<"idle" | "installing" | "installed">("idle");
  const isIOSDevice = isIOS();

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const handleAppInstalled = () => {
      setInstallStatus("installed");
      installPromptRef.current = null;
      setCanInstall(false);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    const prompt = installPromptRef.current;
    if (!prompt) return;
    setInstallStatus("installing");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstallStatus("installed");
      } else {
        setInstallStatus("idle");
      }
    } catch {
      setInstallStatus("idle");
    } finally {
      installPromptRef.current = null;
      setCanInstall(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10 text-foreground">
      <header className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-card shadow-sm">
          <SmartphoneIcon className="size-7 text-foreground/80" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">T3 Code</h1>
          <p className="text-sm text-muted-foreground">Mobile access from your desktop session</p>
        </div>
        {hasToken ? (
          <p className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success-foreground">
            <CheckCircle2Icon className="size-3" />
            Pairing link captured
          </p>
        ) : null}
      </header>

      {installStatus === "installed" ? (
        <InstalledSuccessPanel onTryOpenApp={onTryOpenApp} />
      ) : isIOSDevice ? (
        <IOSAddToHomeScreenPanel />
      ) : (
        <AndroidInstallPanel
          canInstall={canInstall}
          isInstalling={installStatus === "installing"}
          onInstall={handleInstallClick}
        />
      )}

      <div className="flex flex-col items-center gap-2 text-center">
        <button
          type="button"
          onClick={onTryOpenApp}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Already have T3 Code? Open the app.
        </button>
        {hasToken ? (
          <p className="text-[11px] text-muted-foreground/70">
            This pairing link expires in 24 hours.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AndroidInstallPanel({
  canInstall,
  isInstalling,
  onInstall,
}: {
  canInstall: boolean;
  isInstalling: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card/60 p-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Install T3 Code as an app on this phone. It opens full-screen, runs offline-ready, and stays
        signed in.
      </p>
      <Button
        type="button"
        size="lg"
        onClick={onInstall}
        disabled={!canInstall || isInstalling}
        className="w-full gap-2"
      >
        <DownloadIcon className="size-4" />
        {isInstalling
          ? "Installing…"
          : canInstall
            ? "Install T3 Code"
            : "Waiting for install option…"}
      </Button>
      {!canInstall ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          If the install option doesn&apos;t appear, open Chrome&apos;s menu and tap{" "}
          <span className="font-medium text-foreground/80">Install app</span> or{" "}
          <span className="font-medium text-foreground/80">Add to Home screen</span>.
        </p>
      ) : null}
    </div>
  );
}

function IOSAddToHomeScreenPanel() {
  return (
    <div className="space-y-4 rounded-2xl border border-border/70 bg-card/60 p-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        On iPhone, add T3 Code to your home screen to use it as an app:
      </p>
      <ol className="space-y-3 text-sm">
        <li className="flex items-start gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-[11px] font-semibold">
            1
          </span>
          <span className="leading-relaxed text-foreground/90">
            Tap the <ShareIcon className="inline size-4 align-text-bottom" /> Share button in
            Safari&apos;s toolbar.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-[11px] font-semibold">
            2
          </span>
          <span className="leading-relaxed text-foreground/90">
            Scroll down and choose <span className="font-medium">Add to Home Screen</span>.
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-[11px] font-semibold">
            3
          </span>
          <span className="leading-relaxed text-foreground/90">
            Open T3 Code from the new icon — pairing completes automatically.
          </span>
        </li>
      </ol>
    </div>
  );
}

function InstalledSuccessPanel({ onTryOpenApp }: { onTryOpenApp: (() => void) | undefined }) {
  return (
    <div className="space-y-3 rounded-2xl border border-success/30 bg-success/10 p-5 text-center">
      <CheckCircle2Icon className="mx-auto size-8 text-success-foreground" />
      <p className="text-sm font-medium text-success-foreground">T3 Code is installed.</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Open it from your home screen — pairing completes automatically.
      </p>
      {onTryOpenApp ? (
        <Button type="button" variant="outline" size="sm" onClick={onTryOpenApp}>
          Try to open the app
        </Button>
      ) : null}
    </div>
  );
}
