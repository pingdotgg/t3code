import { useAtomValue } from "@effect/atom-react";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { useRef, useState } from "react";
import { environmentPresentations } from "../../state/presentation";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { ChatGptUsageButton } from "./ChatGptUsageButton";

const STORAGE_KEY = "t3:chatgpt-sharing-welcome:v1";
function readAcknowledgedProfiles(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function ChatGptWelcomeCoordinator() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const [acknowledged, setAcknowledged] = useState(readAcknowledgedProfiles);
  const continueRef = useRef<HTMLButtonElement>(null);
  const profiles = [...presentations].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase !== "connected"
      ? []
      : (providersByEnvironment.get(environmentId) ?? [])
          .filter(usesChatGptSharing)
          .map((provider) => ({
            key: JSON.stringify([
              environmentId,
              provider.instanceId,
              provider.auth.profileId ?? provider.auth.email ?? "default",
            ]),
            environmentLabel: presentation.entry.target.label,
            providerName: provider.displayName ?? "Codex",
          })),
  );
  const next = profiles.find((profile) => !acknowledged.includes(profile.key));
  const dismiss = () => {
    if (!next) return;
    const updated = [...acknowledged, next.key];
    setAcknowledged(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  };
  return (
    <Dialog
      open={next !== undefined}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false} initialFocus={continueRef}>
        <DialogHeader>
          <OpenAI aria-hidden className="mb-3 size-8 text-strong-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>Your ChatGPT plan is connected</DialogTitle>
            <DialogDescription>
              Your ChatGPT plan covers eligible Codex usage. Manage shared usage and credit settings
              in ChatGPT.
            </DialogDescription>
            <p className="min-w-0 wrap-anywhere text-meta text-dim-foreground">
              {next?.providerName} on {next?.environmentLabel}
            </p>
          </div>
        </DialogHeader>
        <DialogFooter className="sm:items-center">
          <ChatGptUsageButton size="default" variant="secondary" className="sm:mr-auto" />
          <Button ref={continueRef} onClick={dismiss}>
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
