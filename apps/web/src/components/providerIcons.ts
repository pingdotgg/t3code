import type { ProviderKind } from "@repo/contracts";
import type { ProviderPickerKind } from "../session-logic";
import { ClaudeAI, CursorIcon, type Icon, OpenAI } from "./Icons";

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
};

export const PROVIDER_ICON_BY_PROVIDER_PICKER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeCode: ClaudeAI,
  cursor: CursorIcon,
};
