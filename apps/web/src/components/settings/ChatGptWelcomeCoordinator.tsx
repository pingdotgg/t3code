import { useAtomValue } from "@effect/atom-react";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { useT } from "../../hooks/useI18n";
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
  const t = useT();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const [acknowledged, setAcknowledged] = useState(readAcknowledgedProfiles);
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
      <DialogPopup>
        <DialogHeader>
          <OpenAI className="mb-2 size-8" aria-hidden="true" />
          <DialogTitle>{t("settings.providers.chatgpt.welcome.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.providers.chatgpt.welcome.description")}
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            {next
              ? t("settings.providers.chatgpt.welcome.providerOnEnvironment", {
                  provider: next.providerName,
                  environment: next.environmentLabel,
                })
              : null}
          </p>
        </DialogHeader>
        <DialogFooter>
          <ChatGptUsageButton />
          <Button onClick={dismiss}>{t("settings.providers.chatgpt.welcome.continue")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
