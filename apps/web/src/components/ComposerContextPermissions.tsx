import type { RuntimeMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { useT } from "../hooks/useI18n";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { runtimeModeConfig } from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The new-thread strip names the permissions the first send will use; clicking opens them. */
export function ComposerContextPermissions(props: {
  runtimeMode: RuntimeMode;
  onOpen: () => void;
}) {
  const t = useT();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const { icon: Icon, labelKey } = runtimeModeConfig[props.runtimeMode];
  const label = t(labelKey);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            className="ms-auto min-w-0 shrink-0"
            aria-label={t("app.permissions.ariaLabel", { label })}
            aria-haspopup="menu"
            data-composer-context-control
            onClick={props.onOpen}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>
        {t("app.permissions.title")}
        {shortcutLabel ? ` · ${shortcutLabel}` : null}
      </TooltipPopup>
    </Tooltip>
  );
}
