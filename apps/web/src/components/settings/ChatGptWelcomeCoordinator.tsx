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
      <DialogPopup className="sm:max-w-100" showCloseButton={false} initialFocus={continueRef}>
        <DialogHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-control surface-well">
            <OpenAI aria-hidden className="size-4.5 text-foreground" />
          </div>
          <DialogTitle>Your ChatGPT plan is connected</DialogTitle>
          <DialogDescription>
            Eligible T3 Code usage now counts toward your ChatGPT plan. Manage usage and credits in
            ChatGPT.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:items-center sm:justify-between">
          <p className="min-w-0 truncate text-meta text-dim-foreground max-sm:order-last">
            {next?.providerName} on {next?.environmentLabel}
          </p>
          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row">
            <ChatGptUsageButton size="standard" variant="secondary" />
            <Button ref={continueRef} size="standard" onClick={dismiss}>
              Continue
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
