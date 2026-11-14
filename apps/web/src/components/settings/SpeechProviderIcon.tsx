import { openRouterIcon } from "@t3tools/client-runtime/provider-clients";
import {
  CLOUD_SPEECH_LABELS,
  READ_ALOUD_LABELS,
  ProviderDriverKind,
  type CloudSpeechProvider,
  type ReadAloudSettings,
} from "@t3tools/contracts";
import { Volume2Icon, VolumeXIcon } from "lucide-react";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";

export function SpeechProviderIcon({
  provider,
}: {
  provider: CloudSpeechProvider | ReadAloudSettings["provider"];
}) {
  if (provider === "off") return <VolumeXIcon aria-hidden className="size-4 shrink-0" />;
  if (provider === "system") return <Volume2Icon aria-hidden className="size-4 shrink-0" />;
  if (provider === "openrouter")
    return <ProviderPackageIcon icon={openRouterIcon} aria-hidden className="size-4 shrink-0" />;
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(provider === "xai" ? "grok" : "codex")}
      displayName={provider === "openai" ? CLOUD_SPEECH_LABELS.openai : READ_ALOUD_LABELS[provider]}
      iconClassName="size-4"
    />
  );
}
