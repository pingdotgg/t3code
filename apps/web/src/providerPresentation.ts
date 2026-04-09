import { type ProviderPickerKind } from "./session-logic";
import { type Icon, ClaudeAI, CursorIcon, OpenAI } from "./components/Icons";

export const PROVIDER_ICON_BY_KIND: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
};

export function providerIconClassName(
  provider: ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : fallbackClassName;
}
