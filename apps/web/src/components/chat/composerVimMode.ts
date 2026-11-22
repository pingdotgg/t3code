import { msg } from "gt-react";

import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { toastManager } from "../ui/toast";

export function toggleComposerVimMode(): void {
  const enabled = !getClientSettings().composerVimMode;
  void updateClientSettings({ composerVimMode: enabled });
  toastManager.add({
    id: "composer-vim-mode",
    title: m(enabled ? msg("Vim mode on") : msg("Vim mode off")),
    timeout: 1500,
  });
}
