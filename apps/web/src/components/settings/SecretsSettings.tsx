import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BrowserLoginError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { serverEnvironment } from "../../state/server";
import { BROWSER_LOGIN_REASON_TEXT } from "../preview/PreviewLoginsButton.logic";
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
              Update T3 Code on <Var>{environment.label}</Var> to manage its secret providers.
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
      {environment.serverConfig?.environment.capabilities.browserLogins === true ? (
        <BrowserLoginsSection
          environmentId={environmentId}
          providers={entries.flatMap(([id, config]) =>
            LOGIN_PROVIDER_KINDS.has(config.kind) ? [{ id, label: config.label }] : [],
          )}
          readOnly={readOnly}
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

const isBrowserLoginError = Schema.is(BrowserLoginError);

// Kinds whose server driver can list logins; the server checks this again when saving.
const LOGIN_PROVIDER_KINDS = new Set<string>(["one_password"]);

function BrowserLoginsSection({
  environmentId,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<{ readonly id: SecretProviderId; readonly label: string }>;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.browserLogins);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const listVaults = useAtomCommand(serverEnvironment.listBrowserLoginVaults, {
    reportFailure: false,
  });
  const checkLogins = useAtomCommand(serverEnvironment.checkBrowserLogins, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<{
    readonly provider: SecretProviderId | null;
    readonly vault: string;
  } | null>(null);
  const [vaults, setVaults] = useState<{
    readonly provider: SecretProviderId;
    readonly names: ReadonlyArray<string> | null;
  } | null>(null);
  // The check's result, as a `msg()` string or a count, resolved where it renders.
  const [check, setCheck] = useState<
    | { readonly kind: "checking" }
    | { readonly kind: "found"; readonly logins: number }
    | { readonly kind: "error"; readonly message: string }
    | null
  >(null);
  const enabled = saved !== undefined || draft !== null;
  const provider = draft?.provider ?? saved?.provider ?? providers[0]?.id ?? null;
  const vault = draft?.vault ?? saved?.vault ?? "";
  const vaultNames = vaults?.provider === provider ? vaults.names : undefined;

  const loadVaults = async (id: SecretProviderId) => {
    const result = await listVaults({ environmentId, input: { provider: id } });
    setVaults({
      provider: id,
      names:
        result._tag === "Success" && result.value.vaults !== null
          ? result.value.vaults.map((entry) => entry.name)
          : null,
    });
  };
  const loadProviderVaults = useEffectEvent((id: SecretProviderId) => void loadVaults(id));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the chosen provider's vault names from the server
  useEffect(() => {
    if (!enabled || readOnly || provider === null) return;
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    loadProviderVaults(provider);
  }, [enabled, provider, readOnly]);

  const save = (next: { readonly provider: SecretProviderId; readonly vault: string }) => {
    setCheck(null);
    if (next.vault.trim() === "") {
      setDraft(next);
      return;
    }
    setDraft(null);
    updateSettings({ browserLogins: { provider: next.provider, vault: next.vault.trim() } });
  };

  const runCheck = async () => {
    if (provider === null || vault.trim() === "") return;
    setCheck({ kind: "checking" });
    const result = await checkLogins({
      environmentId,
      input: { provider, vault: vault.trim() },
    });
    if (result._tag === "Success") {
      setCheck({ kind: "found", logins: result.value.logins });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setCheck({
      kind: "error",
      message: isBrowserLoginError(error)
        ? BROWSER_LOGIN_REASON_TEXT[error.reason]
        : msg("Couldn't read the vault."),
    });
  };

  const checkText =
    check === null
      ? undefined
      : check.kind === "checking"
        ? gt("Checking…")
        : check.kind === "found"
          ? gt("{count, plural, =1 {1 login found} other {{count} logins found}}", {
              count: check.logins,
            })
          : messages(check.message);

  return (
    <SettingsSection {...setting("browser-logins")}>
      <SettingsRow
        title={gt("Fill browser logins")}
        description={gt(
          "Fill logins from one vault into pages in the in-app browser. Agents can use every login in it. Use a vault made for this.",
        )}
        control={
          <Switch
            checked={enabled}
            disabled={readOnly || (!enabled && providers.length === 0)}
            onCheckedChange={(checked) => {
              setCheck(null);
              if (checked) {
                setDraft({ provider, vault: "" });
                return;
              }
              setDraft(null);
              if (saved !== undefined) updateSettings({ browserLogins: null });
            }}
            aria-label={gt("Fill browser logins")}
          />
        }
      />
      {!enabled && providers.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          <T>Add a 1Password provider above to fill logins from it.</T>
        </p>
      ) : null}
      {enabled && provider !== null ? (
        <>
          <SettingsRow
            title={gt("Secret provider")}
            control={
              <Select
                value={provider}
                disabled={readOnly}
                onValueChange={(value) => {
                  if (value === null) return;
                  save({ provider: value as SecretProviderId, vault: "" });
                }}
              >
                <SelectTrigger aria-label={gt("Secret provider for browser logins")} size="xs">
                  <SelectValue>
                    {providers.find((entry) => entry.id === provider)?.label ?? provider}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {providers.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={gt("Vault", { $context: "a 1Password vault, the noun" })}
            description={checkText}
            control={
              <div className="flex items-center gap-1">
                {vaultNames ? (
                  <Select
                    value={vault}
                    disabled={readOnly}
                    onValueChange={(value) => {
                      if (value === null) return;
                      save({ provider, vault: value });
                    }}
                  >
                    <SelectTrigger aria-label={gt("Vault for browser logins")} size="xs">
                      <SelectValue>{vault === "" ? gt("Choose a vault") : vault}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {vaultNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Input
                    size="sm"
                    value={vault}
                    disabled={readOnly}
                    placeholder={gt("Vault name")}
                    aria-label={gt("Vault for browser logins")}
                    onChange={(event) => setDraft({ provider, vault: event.target.value })}
                    onBlur={() => save({ provider, vault })}
                  />
                )}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={readOnly || vault.trim() === ""}
                  onClick={() => void runCheck()}
                >
                  <T>Check</T>
                </Button>
              </div>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
