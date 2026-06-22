"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  INTEGRATION_DEFINITIONS,
  INTEGRATION_DISPLAY_NAMES,
  INTEGRATION_KINDS,
  IntegrationAccountId,
  type IntegrationAccount,
  type IntegrationKind,
} from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { usePrimaryEnvironment } from "~/state/environments";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { toastManager } from "../ui/toast";
import { GitHubIcon, GitLabIcon, JiraIcon, LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const INTEGRATION_ICON_BY_KIND: Record<IntegrationKind, typeof GitHubIcon> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  jira: JiraIcon,
  linear: LinearIcon,
};

function slugifyAccountName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function nextAvailableAccountId(
  kind: IntegrationKind,
  name: string,
  existingAccounts: readonly IntegrationAccount[],
): string {
  const slug = slugifyAccountName(name);
  if (slug.length === 0) return "";

  const base = `${kind}_${slug}`;
  if (!existingAccounts.some((account) => account.id === base)) {
    return base;
  }

  let suffix = 2;
  while (existingAccounts.some((account) => account.id === `${base}_${suffix}`)) {
    suffix += 1;
  }
  return `${base}_${suffix}`;
}

function isDuplicateAccountName(
  accounts: readonly IntegrationAccount[],
  name: string,
  excludeId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  return accounts.some(
    (account) => account.id !== excludeId && account.name.trim().toLowerCase() === normalized,
  );
}

interface AccountDialogState {
  readonly kind: IntegrationKind;
  readonly account: IntegrationAccount | null;
}

function AccountDialog({
  state,
  existingAccounts,
  onSave,
  onCancel,
}: {
  state: AccountDialogState;
  existingAccounts: readonly IntegrationAccount[];
  onSave: (account: IntegrationAccount) => void;
  onCancel: () => void;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const testIntegrationToken = useAtomCommand(serverEnvironment.testIntegrationToken, {
    reportFailure: false,
  });
  const definition = INTEGRATION_DEFINITIONS[state.kind];
  const requiresBaseUrl = definition.baseUrlRequired === true;
  const steps = requiresBaseUrl ? ["Name", "Site", "Token", "Review"] : ["Name", "Token", "Review"];

  const [step, setStep] = useState(0);
  const [name, setName] = useState(state.account?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(state.account?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const isEdit = state.account !== null;
  const preserveSavedToken =
    isEdit && state.account?.apiKeyRedacted === true && apiKey.trim().length === 0;
  const preserveSavedBaseUrl =
    isEdit && (baseUrl.trim().length === 0 || baseUrl.trim() === (state.account?.baseUrl ?? ""));

  useEffect(() => {
    setStep(0);
    setName(state.account?.name ?? "");
    setBaseUrl(state.account?.baseUrl ?? "");
    setApiKey("");
    setError(null);
    setIsTesting(false);
  }, [state.account, state.kind]);

  const validateName = useCallback(() => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Account name is required.");
      return null;
    }
    if (isDuplicateAccountName(existingAccounts, trimmedName, state.account?.id)) {
      setError(`An account named "${trimmedName}" already exists.`);
      return null;
    }
    return trimmedName;
  }, [existingAccounts, name, state.account?.id]);

  const validateBaseUrl = useCallback(() => {
    if (!requiresBaseUrl) return null;
    const trimmedBaseUrl = baseUrl.trim();
    if (trimmedBaseUrl.length === 0) {
      if (state.account?.baseUrl !== undefined) {
        return state.account.baseUrl;
      }
      setError(`${definition.baseUrlLabel ?? "Base URL"} is required.`);
      return null;
    }
    try {
      return new URL(trimmedBaseUrl).toString();
    } catch {
      setError(`${definition.baseUrlLabel ?? "Base URL"} must be a valid URL.`);
      return null;
    }
  }, [baseUrl, definition.baseUrlLabel, requiresBaseUrl, state.account?.baseUrl]);

  const handleNext = useCallback(() => {
    setError(null);
    if (step === 0) {
      if (validateName() !== null) {
        setStep(1);
      }
      return;
    }
    if (requiresBaseUrl && step === 1) {
      if (validateBaseUrl() !== null) {
        setStep(2);
      }
      return;
    }
    if ((requiresBaseUrl && step === 2) || (!requiresBaseUrl && step === 1)) {
      if (apiKey.trim().length === 0 && !preserveSavedToken) {
        setError(`${definition.tokenLabel} is required.`);
        return;
      }
      setStep(requiresBaseUrl ? 3 : 2);
    }
  }, [
    apiKey,
    definition.tokenLabel,
    preserveSavedToken,
    requiresBaseUrl,
    step,
    validateBaseUrl,
    validateName,
  ]);

  const handleSave = useCallback(async () => {
    const trimmedName = validateName();
    if (trimmedName === null) {
      setStep(0);
      return;
    }

    const normalizedBaseUrl = validateBaseUrl();
    if (requiresBaseUrl && normalizedBaseUrl === null) {
      setStep(1);
      return;
    }

    const trimmedKey = apiKey.trim();
    if (!preserveSavedToken && trimmedKey.length === 0) {
      setError(`${definition.tokenLabel} is required.`);
      setStep(requiresBaseUrl ? 2 : 1);
      return;
    }

    if (environmentId === null) {
      setError("Unable to validate integration tokens without an active environment.");
      return;
    }

    try {
      setIsTesting(true);
      const result = await testIntegrationToken({
        environmentId,
        input: preserveSavedToken
          ? {
              kind: state.kind,
              accountId: state.account?.id,
              accountName: trimmedName,
              ...(normalizedBaseUrl !== null ? { baseUrl: normalizedBaseUrl } : {}),
              useStoredToken: true,
            }
          : {
              kind: state.kind,
              accountId: state.account?.id,
              accountName: trimmedName,
              ...(normalizedBaseUrl !== null ? { baseUrl: normalizedBaseUrl } : {}),
              apiKey: trimmedKey,
            },
      });

      if (result._tag !== "Success") {
        throw new Error("Could not verify the token.");
      }

      toastManager.add({
        type: "success",
        title: `${INTEGRATION_DISPLAY_NAMES[state.kind]} token verified`,
        description: `Connected to ${result.value.accountLabel}.`,
      });

      const existing = state.account;
      const nextId =
        existing?.id ??
        IntegrationAccountId.make(
          nextAvailableAccountId(state.kind, trimmedName, existingAccounts),
        );
      onSave({
        id: nextId,
        name: trimmedName,
        ...(normalizedBaseUrl !== null
          ? { baseUrl: normalizedBaseUrl }
          : preserveSavedBaseUrl && existing?.baseUrl !== undefined
            ? { baseUrl: existing.baseUrl }
            : {}),
        apiKey: trimmedKey,
        ...(trimmedKey.length > 0 || preserveSavedToken ? { apiKeyRedacted: true } : {}),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not verify the token.";
      setError(message);
      setStep(requiresBaseUrl ? 2 : 1);
      toastManager.add({
        type: "error",
        title: `${INTEGRATION_DISPLAY_NAMES[state.kind]} token check failed`,
        description: message,
      });
    } finally {
      setIsTesting(false);
    }
  }, [
    apiKey,
    definition.tokenLabel,
    environmentId,
    existingAccounts,
    onSave,
    preserveSavedBaseUrl,
    preserveSavedToken,
    requiresBaseUrl,
    state.account,
    state.kind,
    validateBaseUrl,
    validateName,
  ]);

  const reviewBaseUrl = preserveSavedBaseUrl ? state.account?.baseUrl : baseUrl.trim();

  const submitLabel = preserveSavedToken
    ? "Save changes"
    : isEdit
      ? "Test token & save"
      : "Test token & add account";

  const currentStepLabel = steps[step] ?? steps[steps.length - 1] ?? "Review";

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`${isEdit ? "Edit" : "Add"} ${INTEGRATION_DISPLAY_NAMES[state.kind]} account`}</DialogTitle>
          <DialogDescription>{definition.accountHint}</DialogDescription>
          <div className="grid gap-2 pt-2 sm:grid-cols-4">
            {steps.map((label, index) => {
              const active = index === step;
              const complete = index < step;
              return (
                <button
                  key={label}
                  type="button"
                  className={
                    active
                      ? "flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left"
                      : complete
                        ? "flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left"
                        : "flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left"
                  }
                  onClick={() => setStep(index)}
                >
                  <span
                    className={
                      active
                        ? "grid size-5 place-items-center rounded-full border border-primary text-xs font-semibold text-primary"
                        : complete
                          ? "grid size-5 place-items-center rounded-full border border-primary bg-primary text-xs font-semibold text-primary-foreground"
                          : "grid size-5 place-items-center rounded-full border border-muted-foreground/30 text-xs font-semibold text-muted-foreground"
                    }
                  >
                    {complete ? <CheckIcon className="size-3" /> : index + 1}
                  </span>
                  <span className="min-w-0 truncate text-xs font-semibold">{label}</span>
                </button>
              );
            })}
          </div>
        </DialogHeader>

        <div className="space-y-4 p-5">
          {step === 0 ? (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Account name</span>
              <Input
                autoFocus
                value={name}
                onChange={(event) => {
                  setError(null);
                  setName(event.target.value);
                }}
                placeholder={definition.accountPlaceholder}
              />
            </label>
          ) : null}

          {requiresBaseUrl && step === 1 ? (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {definition.baseUrlLabel ?? "Base URL"}
              </span>
              <Input
                autoFocus
                value={baseUrl}
                onChange={(event) => {
                  setError(null);
                  setBaseUrl(event.target.value);
                }}
                placeholder={definition.baseUrlPlaceholder}
              />
            </label>
          ) : null}

          {(requiresBaseUrl ? step === 2 : step === 1) ? (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {definition.tokenLabel}
              </span>
              <Input
                autoFocus
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setError(null);
                  setApiKey(event.target.value);
                }}
                placeholder={
                  isEdit
                    ? `Leave blank to keep the saved ${definition.tokenLabel}`
                    : `Enter ${definition.tokenLabel}`
                }
              />
              <p className="text-[11px] text-muted-foreground">
                {isEdit && state.account?.apiKeyRedacted
                  ? "The saved key stays encrypted unless you replace it."
                  : "The key is stored encrypted at rest."}
              </p>
            </label>
          ) : null}

          {(requiresBaseUrl ? step === 3 : step === 2) ? (
            <div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              <p className="text-foreground">
                {preserveSavedToken
                  ? "We’ll keep the existing encrypted key and save these changes."
                  : "We’ll test this token from the server before saving the account."}
              </p>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-background px-3 py-2">
                  <dt className="text-muted-foreground">Integration</dt>
                  <dd className="font-medium text-foreground">
                    {INTEGRATION_DISPLAY_NAMES[state.kind]}
                  </dd>
                </div>
                <div className="rounded-md border border-border/70 bg-background px-3 py-2">
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="font-medium text-foreground">
                    {name.trim() || "Untitled account"}
                  </dd>
                </div>
                {requiresBaseUrl ? (
                  <div className="rounded-md border border-border/70 bg-background px-3 py-2 sm:col-span-2">
                    <dt className="text-muted-foreground">Base URL</dt>
                    <dd className="font-medium text-foreground">{reviewBaseUrl || "Not set"}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="px-5 pb-5">
          <div className="mr-auto flex items-center gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            {step > 0 ? (
              <Button
                variant="outline"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
              >
                Back
              </Button>
            ) : null}
          </div>
          {currentStepLabel === "Review" ? (
            <Button onClick={() => void handleSave()} disabled={isTesting}>
              {isTesting ? "Testing…" : submitLabel}
            </Button>
          ) : (
            <Button onClick={handleNext}>Next</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function IntegrationsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [activeDialog, setActiveDialog] = useState<AccountDialogState | null>(null);

  const sections = useMemo(
    () =>
      INTEGRATION_KINDS.map((kind) => ({
        kind,
        accounts: settings.integrations[kind] ?? [],
      })),
    [settings.integrations],
  );

  const handleSaveAccount = useCallback(
    (kind: IntegrationKind, account: IntegrationAccount) => {
      const nextAccounts = (() => {
        const currentAccounts: readonly IntegrationAccount[] = settings.integrations[kind] ?? [];
        const existingIndex = currentAccounts.findIndex(
          (candidate: IntegrationAccount) => candidate.id === account.id,
        );
        if (existingIndex === -1) {
          return [...currentAccounts, account];
        }
        return currentAccounts.map((candidate: IntegrationAccount) =>
          candidate.id === account.id ? account : candidate,
        );
      })();

      void updateSettings({
        integrations: {
          ...settings.integrations,
          [kind]: nextAccounts,
        },
      });
      setActiveDialog(null);
    },
    [settings.integrations, updateSettings],
  );

  const handleDeleteAccount = useCallback(
    (kind: IntegrationKind, accountId: string) => {
      const currentAccounts: readonly IntegrationAccount[] = settings.integrations[kind] ?? [];
      void updateSettings({
        integrations: {
          ...settings.integrations,
          [kind]: currentAccounts.filter((account: IntegrationAccount) => account.id !== accountId),
        },
      });
    },
    [settings.integrations, updateSettings],
  );

  return (
    <SettingsPageContainer>
      <div className="px-2 pb-2 pt-1">
        <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
      </div>

      {sections.map(({ kind, accounts }) => {
        const Icon = INTEGRATION_ICON_BY_KIND[kind];
        const definition = INTEGRATION_DEFINITIONS[kind];
        return (
          <SettingsSection
            key={kind}
            title={INTEGRATION_DISPLAY_NAMES[kind]}
            icon={<Icon className="size-4 shrink-0" />}
            headerAction={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setActiveDialog({ kind, account: null })}
              >
                <PlusIcon className="size-3.5" />
                Add account
              </Button>
            }
          >
            {accounts.length === 0 ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                No {INTEGRATION_DISPLAY_NAMES[kind]} accounts yet.
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {accounts.map((account) => (
                  <SettingsRow
                    key={account.id}
                    title={account.name}
                    description={definition.accountHint}
                    control={
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setActiveDialog({ kind, account })}
                        >
                          <PencilIcon className="size-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => handleDeleteAccount(kind, account.id)}
                        >
                          <Trash2Icon className="size-3.5" />
                          Remove
                        </Button>
                      </div>
                    }
                  >
                    <div className="pb-3.5 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-1">
                        <KeyRoundIcon className="size-3.5" />
                        {INTEGRATION_DISPLAY_NAMES[kind]} account
                      </span>
                    </div>
                  </SettingsRow>
                ))}
              </div>
            )}
          </SettingsSection>
        );
      })}

      {activeDialog ? (
        <AccountDialog
          state={activeDialog}
          existingAccounts={settings.integrations[activeDialog.kind] ?? []}
          onSave={(account) => handleSaveAccount(activeDialog.kind, account)}
          onCancel={() => setActiveDialog(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
