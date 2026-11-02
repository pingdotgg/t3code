import { createTranslator } from "@t3tools/client-runtime/i18n";

import { getUiLocale } from "../hooks/useI18n";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerConfigAtom, primaryServerConfigEventAtom } from "../state/server";
import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";
import { createKeybindingsUpdateToastController } from "./KeybindingsUpdateToast.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Toasts each keybindings reload the primary server reports. */
export function startKeybindingsUpdateToasts(): () => void {
  const controller = createKeybindingsUpdateToastController({});
  return subscribeAtomChanges(primaryServerConfigEventAtom, (event) => {
    const decision = controller.handle(event);
    if (!decision) return;
    const t = createTranslator(getUiLocale());

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("app.keybindings.updated"),
        description: t("app.keybindings.reloaded"),
      });
      return;
    }

    const serverConfig = appAtomRegistry.get(primaryServerConfigAtom);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: t("app.keybindings.invalid"),
        description: (
          <KeybindingsConfigWarning
            message={decision.message}
            environmentId={appAtomRegistry.get(primaryEnvironmentIdAtom)}
            configPath={serverConfig?.keybindingsConfigPath ?? null}
            availableEditors={serverConfig?.availableEditors ?? []}
          />
        ),
      }),
    );
  });
}
