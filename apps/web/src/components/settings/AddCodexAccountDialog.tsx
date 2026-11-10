import { AuthProvidersManageScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";

import { useT } from "../../hooks/useI18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { MultipleAccountsNote } from "./MultipleAccountsNote";
import { SettingsRow } from "./settingsLayout";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export function AddCodexAccountDialog({
  environmentId,
  onClose,
  renderSetup,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  // Told when the account is created; the dialog then runs its own sign-in.
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string) => void)
    | undefined;
  readonly renderSetup: (instanceId: ProviderInstanceId, provider: ServerProvider) => ReactNode;
}) {
  const t = useT();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, "Add ChatGPT account");
  const [name, setName] = useState("Personal");
  const displayName = `ChatGPT - ${name.trim()}`;
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  // Closes itself once the new account connects; the owner unmounts it after
  // the close animation.
  const connected = usesChatGptSharing(provider);

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const id = ProviderInstanceId.make(`codex_${randomUUID()}`);
    const result = await update({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            ...settings.providerInstances,
            [id]: {
              driver: CODEX_DRIVER_KIND,
              displayName,
              enabled: true,
              config: { enabled: true, setupMode: "managed" },
            },
          },
        },
      },
    });
    if (result._tag === "Success") {
      onAccountCreated?.(id, displayName);
      setInstanceId(id);
    }
    setPending(false);
  };

  return (
    <Dialog
      open={!connected}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && connected) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={instanceId ? displayName : t("settings.providers.addCodex.title")}
          description={t("settings.providers.addCodex.description")}
        />
        <WizardPanel>
          {instanceId ? (
            provider?.setup ? (
              renderSetup(instanceId, provider)
            ) : (
              <SettingsRow
                title={t("settings.providers.addCodex.runtime")}
                description={t("settings.providers.addCodex.preparing")}
              />
            )
          ) : (
            <form
              id="add-codex-account"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title={t("settings.providers.addCodex.accountName")}
                description={t("settings.providers.addCodex.accountNameDescription")}
                control={
                  <Input
                    aria-label={t("settings.providers.addCodex.accountName")}
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("settings.providers.addCodex.accountNamePlaceholder")}
                  />
                }
              />
              <MultipleAccountsNote environmentId={environmentId} driver={CODEX_DRIVER_KIND} />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              {t("settings.providers.addCodex.finishLater")}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                {t("settings.providers.addCodex.cancel")}
              </Button>
              <Button
                type="submit"
                form="add-codex-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                {pending
                  ? t("settings.providers.addCodex.adding")
                  : t("settings.providers.addCodex.continue")}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
