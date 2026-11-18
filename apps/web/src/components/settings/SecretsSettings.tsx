import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { OnePasswordIcon, type Icon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SecretProviderDialog } from "./SecretProviderDialog";
import { classifySecretProvider } from "./SecretProviderDialog.logic";
import { secretProviderUses } from "./SecretsSettings.logic";
import {
  classifyProviderEnvironmentAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { appName } from "@t3tools/shared/appName";

const SECRET_PROVIDER_KINDS: Readonly<
  Record<string, { readonly name: string; readonly icon: Icon }>
> = {
  one_password: { name: "1Password", icon: OnePasswordIcon },
};

export function SecretsSettingsPanel() {
  const setting = useSearchableSetting();
  const { scope, environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.secretProviderSettings !== true ? (
        <SettingsSection {...setting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>
              Update <Var>{appName()}</Var> on <Var>{environment.label}</Var> to manage its secret
              providers.
            </T>
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentSecretProviders
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection {...setting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>
              Connect an environment to manage the secret providers its provider variables read
              from.
            </T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSecretProviders({
  environment,
  projectScoped,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const environmentId = environment.environmentId;
  const sessionState = useEnvironmentSessionState(environmentId);
  // The server requires the same grant for secret providers as for provider settings.
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess: resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }),
  });
  const readOnly = access.kind !== "editable" || projectScoped;
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [dialog, setDialog] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly id: SecretProviderId }
  >(null);
  const entries = Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>;
  const editingConfig = dialog?.mode === "edit" ? providers[dialog.id] : undefined;
  const editing =
    dialog?.mode === "edit" && editingConfig !== undefined
      ? { id: dialog.id, config: editingConfig }
      : undefined;
  return (
    <>
      <SettingsSection
        {...setting("secret-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add provider</T>
            </Button>
          ) : null
        }
      >
        {projectScoped ? (
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            <T>Environment-wide setting. Select an environment to change it.</T>
          </p>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title={gt("No secret providers configured.")}
            description={gt(
              "Add a 1Password account, then pick it as the source of a provider variable.",
            )}
          />
        ) : (
          entries.map(([id, config]) => {
            const classified = classifySecretProvider(config);
            const kind =
              classified.kind === "unsupported"
                ? undefined
                : SECRET_PROVIDER_KINDS[classified.kind];
            return (
              <SettingsRow
                key={id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    {kind ? (
                      <kind.icon className="size-4.5 shrink-0 text-foreground/80" aria-hidden />
                    ) : null}
                    <span className="min-w-0 wrap-anywhere">{config.label}</span>
                  </span>
                }
                description={
                  classified.kind === "one_password" && kind ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0">{kind.name} ·</span>
                      <RedactedSensitiveText
                        value={classified.account}
                        ariaLabel={gt("Toggle account visibility")}
                        revealTooltip={gt("Click to reveal account")}
                        hideTooltip={gt("Click to hide account")}
                        className="max-w-full truncate"
                      />
                    </span>
                  ) : (
                    gt("Unsupported provider ({kind})", { kind: config.kind })
                  )
                }
                control={
                  !readOnly ? (
                    <div className="flex items-center gap-1">
                      {kind ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDialog({ mode: "edit", id })}
                        >
                          <T>Edit</T>
                        </Button>
                      ) : null}
                      <RemoveSecretProviderButton
                        environmentId={environmentId}
                        id={id}
                        label={config.label}
                        onConfirm={() => updateSettings({ secretProviders: { [id]: null } })}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {dialog !== null && !readOnly && (dialog.mode === "add" || editing !== undefined) ? (
        <SecretProviderDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          existingIds={new Set(Object.keys(providers))}
          {...(editing === undefined ? {} : { existing: editing })}
        />
      ) : null}
    </>
  );
}

function RemoveSecretProviderButton({
  environmentId,
  id,
  label,
  onConfirm,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <SecretProviderUses environmentId={environmentId} id={id} label={label} />
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove provider</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function SecretProviderUses({
  environmentId,
  id,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
}) {
  const messages = useMessages();
  const uses = secretProviderUses(useEnvironmentSettings(environmentId), id, messages);
  if (uses.length === 0) {
    return (
      <AlertDialogDescription>
        <T>
          Nothing reads from <Var>{label}</Var>. The secrets themselves are untouched.
        </T>
      </AlertDialogDescription>
    );
  }
  return (
    <>
      <AlertDialogDescription>
        <T>
          These read from <Var>{label}</Var> and will be unset. The secrets themselves are
          untouched.
        </T>
      </AlertDialogDescription>
      <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto ps-5 text-sm wrap-anywhere">
        {uses.map((use) => (
          <li key={use.id}>{use.label}</li>
        ))}
      </ul>
    </>
  );
}
