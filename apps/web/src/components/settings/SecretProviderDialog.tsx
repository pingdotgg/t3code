import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  SecretProviderConfig,
  SecretProviderConfigChoice,
  SecretProviderId,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import * as Result from "effect/Result";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  DRAFT_SECRET_PROVIDER_KIND,
  draftFromSecretProvider,
  secretProviderFromDraft,
  type SecretProviderDraft,
} from "./SecretProviderDialog.logic";

const ACCOUNT_FIELD = "account";
const NO_CHOICES: ReadonlyArray<SecretProviderConfigChoice> = [];

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<SecretProviderDraft>(
    existing ? draftFromSecretProvider(existing.config) : { name: "", account: "" },
  );
  const [submitted, setSubmitted] = useState(false);
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const nameError = submitted ? issues.name : undefined;
  const accountError = submitted ? issues.account : undefined;

  const kind = existing?.config.kind ?? DRAFT_SECRET_PROVIDER_KIND;
  const discoverable =
    builtInSecretProviderDefinitions
      .find(kind)
      ?.discoverableConfigFields?.includes(ACCOUNT_FIELD) === true;
  const canListChoices = useAtomValue(
    serverEnvironment.listSecretProviderConfigChoices.permissionAtom(environmentId),
  );
  const choices = useEnvironmentQuery(
    discoverable && canListChoices
      ? serverEnvironment.secretProviderConfigChoices({
          environmentId,
          input: { kind, field: ACCOUNT_FIELD },
        })
      : null,
  );
  const listedAccounts = choices.data ?? NO_CHOICES;

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    updateSettings({ secretProviders: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.config.label}` : "Add a 1Password provider"}
          </DialogTitle>
          <DialogDescription>
            Provider variables on {environmentLabel} can read values from it by name. Values are
            read with the op CLI on that server when a provider starts.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">Name</Label>
              <Input
                id="secret-provider-name"
                placeholder="Personal"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-account">Account</Label>
              {discoverable ? (
                <Autocomplete
                  items={listedAccounts}
                  itemToStringValue={(item) => item.value}
                  mode="none"
                  openOnInputClick
                  value={draft.account}
                  onValueChange={(account) => update({ account })}
                >
                  <AutocompleteInput
                    id="secret-provider-account"
                    placeholder="my.1password.com"
                    maxLength={253}
                    spellCheck={false}
                    showTrigger={listedAccounts.length > 0}
                    aria-invalid={accountError !== undefined}
                    aria-describedby={
                      accountError !== undefined ? "secret-provider-account-error" : undefined
                    }
                  />
                  {listedAccounts.length > 0 ? (
                    <AutocompletePopup className="w-(--anchor-width)">
                      <AutocompleteList>
                        {listedAccounts.map((item) => (
                          <AutocompleteItem key={item.value} value={item}>
                            <span className="min-w-0 max-w-2/3 truncate text-sm font-medium">
                              {item.label}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                            {item.value !== item.label ? (
                              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                {item.value}
                              </span>
                            ) : null}
                          </AutocompleteItem>
                        ))}
                      </AutocompleteList>
                    </AutocompletePopup>
                  ) : null}
                </Autocomplete>
              ) : (
                <Input
                  id="secret-provider-account"
                  placeholder="my.1password.com"
                  value={draft.account}
                  onChange={(event) => update({ account: event.target.value })}
                  maxLength={253}
                  spellCheck={false}
                  aria-invalid={accountError !== undefined}
                  aria-describedby={
                    accountError !== undefined ? "secret-provider-account-error" : undefined
                  }
                />
              )}
              {accountError !== undefined ? (
                <p
                  id="secret-provider-account-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {accountError}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {discoverable
                  ? "Accounts the op CLI on that server knows are suggested. Type any other shorthand, sign-in address without https://, or ID."
                  : "The account shorthand, sign-in address without https://, or ID that op account list shows."}
              </p>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
