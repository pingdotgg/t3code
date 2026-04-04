import { KeyRoundIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as Schema from "effect/Schema";
import {
  VaultSecretId,
  VaultVariable,
  VaultVariableId,
  type VaultSecretsSnapshot,
  type VaultVariable as VaultVariableType,
} from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

interface SecretEditorRow {
  id: string;
  key: string;
  value: string;
  persisted: boolean;
  updatedAt: string | null;
}

interface VariableEditorRow {
  id: string;
  key: string;
  value: string;
  persisted: boolean;
}

function createInitialVaultSecretsSnapshot(): VaultSecretsSnapshot {
  return {
    enabled: isElectron,
    safeStorageAvailable: isElectron,
    message: isElectron ? "Loading encrypted vault secrets." : null,
    secrets: [],
  };
}

function secretRowsFromSnapshot(snapshot: VaultSecretsSnapshot): SecretEditorRow[] {
  return snapshot.secrets.map((secret) => ({
    id: secret.id,
    key: secret.key,
    value: "",
    persisted: true,
    updatedAt: secret.updatedAt,
  }));
}

function variableRowsFromSettings(variables: readonly VaultVariableType[]): VariableEditorRow[] {
  return variables.map((variable) => ({
    id: variable.id,
    key: variable.key,
    value: variable.value,
    persisted: true,
  }));
}

function formatUpdatedAt(updatedAt: string): string {
  return `Updated ${formatRelativeTimeLabel(updatedAt)}`;
}

function makeSecretRowId(): string {
  return `draft-secret:${randomUUID()}`;
}

function makeVariableRowId(): string {
  return `draft-variable:${randomUUID()}`;
}

function asVaultVariableId(rawId: string) {
  return Schema.decodeUnknownSync(VaultVariableId)(rawId);
}

function asVaultSecretId(rawId: string) {
  return Schema.decodeUnknownSync(VaultSecretId)(rawId);
}

function isMissingDesktopHandlerError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("No handler registered for 'desktop:");
}

function normalizeKey(input: string): string {
  return input.trim().toLocaleLowerCase();
}

export function VaultSettingsPanel() {
  const vaultVariables = useSettings().vaultVariables;
  const { updateSettings } = useUpdateSettings();
  const [vaultSecrets, setVaultSecrets] = useState<VaultSecretsSnapshot>(
    createInitialVaultSecretsSnapshot,
  );
  const [secretRows, setSecretRows] = useState<SecretEditorRow[]>([]);
  const [variableRows, setVariableRows] = useState<VariableEditorRow[]>([]);
  const [savingSecretIds, setSavingSecretIds] = useState<Record<string, boolean>>({});
  const [deletingSecretIds, setDeletingSecretIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setVariableRows((existingRows) => {
      const draftRows = existingRows.filter((row) => !row.persisted);
      return [...variableRowsFromSettings(vaultVariables), ...draftRows];
    });
  }, [vaultVariables]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    let active = true;
    const api = ensureNativeApi();

    const syncSecrets = async () => {
      try {
        const nextSnapshot = await api.vault.listSecrets();
        if (!active) {
          return;
        }
        setVaultSecrets(nextSnapshot);
      } catch (error) {
        if (!active) {
          return;
        }
        if (isMissingDesktopHandlerError(error)) {
          setVaultSecrets({
            enabled: false,
            safeStorageAvailable: true,
            message: "Restart the desktop dev app once to load the latest Vault handlers.",
            secrets: [],
          });
          return;
        }
        toastManager.add({
          type: "error",
          title: "Could not load vault secrets",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      }
    };

    void syncSecrets();
    const unsubscribe = api.vault.subscribeSecrets((nextSnapshot) => {
      if (!active) {
        return;
      }
      setVaultSecrets(nextSnapshot);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSecretRows((existingRows) => {
      const draftRows = existingRows.filter((row) => !row.persisted);
      return [...secretRowsFromSnapshot(vaultSecrets), ...draftRows];
    });
  }, [vaultSecrets]);

  const persistedSecretById = useMemo(
    () => new Map(vaultSecrets.secrets.map((secret) => [secret.id as string, secret] as const)),
    [vaultSecrets.secrets],
  );
  const persistedVariableById = useMemo(
    () => new Map(vaultVariables.map((variable) => [variable.id as string, variable] as const)),
    [vaultVariables],
  );

  const saveVariableRow = (rowId: string) => {
    const row = variableRows.find((entry) => entry.id === rowId);
    if (!row) {
      return;
    }

    const key = row.key.trim();
    const value = row.value.trim();
    if (key.length === 0 || value.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Both fields are required",
        description: "Variables need both a key and a value.",
      });
      return;
    }

    const normalizedKey = normalizeKey(key);
    const hasDuplicate = variableRows.some(
      (entry) => entry.id !== rowId && normalizeKey(entry.key) === normalizedKey,
    );
    if (hasDuplicate) {
      toastManager.add({
        type: "error",
        title: "Duplicate variable name",
        description: `A variable named "${key}" already exists.`,
      });
      return;
    }

    const nextVariable = Schema.decodeUnknownSync(VaultVariable)({
      id: row.persisted ? row.id : asVaultVariableId(randomUUID()),
      key,
      value,
    });
    const nextVariables = row.persisted
      ? vaultVariables.map((variable) => (variable.id === row.id ? nextVariable : variable))
      : [...vaultVariables, nextVariable];

    updateSettings({
      vaultVariables: nextVariables,
    });
    toastManager.add({
      type: "success",
      title: row.persisted ? "Variable updated" : "Variable saved",
      description: `"${key}" is now available to the model in future turns.`,
    });
  };

  const deleteVariableRow = (rowId: string) => {
    const row = variableRows.find((entry) => entry.id === rowId);
    if (!row) {
      return;
    }

    if (!row.persisted) {
      setVariableRows((existingRows) => existingRows.filter((entry) => entry.id !== rowId));
      return;
    }

    updateSettings({
      vaultVariables: vaultVariables.filter((variable) => variable.id !== rowId),
    });
    toastManager.add({
      type: "success",
      title: "Variable deleted",
      description: `"${row.key}" was removed from model-visible variables.`,
    });
  };

  const saveSecretRow = (rowId: string) => {
    const row = secretRows.find((entry) => entry.id === rowId);
    if (!row || !isElectron) {
      return;
    }

    const key = row.key.trim();
    const value = row.value.trim();
    if (key.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Secret name required",
        description: "Give the secret a name before saving it.",
      });
      return;
    }
    if (!row.persisted && value.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Secret value required",
        description: "New secrets need a value before they can be saved.",
      });
      return;
    }

    const normalizedKey = normalizeKey(key);
    const hasDuplicate = secretRows.some(
      (entry) => entry.id !== rowId && normalizeKey(entry.key) === normalizedKey,
    );
    if (hasDuplicate) {
      toastManager.add({
        type: "error",
        title: "Duplicate secret name",
        description: `A secret named "${key}" already exists.`,
      });
      return;
    }

    setSavingSecretIds((existing) => ({
      ...existing,
      [rowId]: true,
    }));
    void ensureNativeApi()
      .vault.saveSecret({
        ...(row.persisted ? { id: asVaultSecretId(row.id) } : {}),
        key,
        ...(value.length > 0 ? { value } : {}),
      })
      .then((nextSnapshot) => {
        setVaultSecrets(nextSnapshot);
        setSecretRows((existingRows) =>
          row.persisted
            ? existingRows.map((entry) =>
                entry.id === rowId
                  ? {
                      ...entry,
                      key,
                      value: "",
                    }
                  : entry,
              )
            : existingRows.filter((entry) => entry.id !== rowId),
        );
        toastManager.add({
          type: "success",
          title: row.persisted ? "Secret updated" : "Secret saved",
          description: `"${key}" was saved into the encrypted desktop vault.`,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save secret",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      })
      .finally(() => {
        setSavingSecretIds((existing) => ({
          ...existing,
          [rowId]: false,
        }));
      });
  };

  const deleteSecretRow = (rowId: string) => {
    const row = secretRows.find((entry) => entry.id === rowId);
    if (!row) {
      return;
    }

    if (!row.persisted || !isElectron) {
      setSecretRows((existingRows) => existingRows.filter((entry) => entry.id !== rowId));
      return;
    }

    setDeletingSecretIds((existing) => ({
      ...existing,
      [rowId]: true,
    }));
    void ensureNativeApi()
      .vault.deleteSecret({
        id: asVaultSecretId(row.id),
      })
      .then((nextSnapshot) => {
        setVaultSecrets(nextSnapshot);
        toastManager.add({
          type: "success",
          title: "Secret deleted",
          description: `"${row.key}" was removed from the encrypted desktop vault.`,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not delete secret",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      })
      .finally(() => {
        setDeletingSecretIds((existing) => ({
          ...existing,
          [rowId]: false,
        }));
      });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="space-y-3">
          <div className="space-y-2">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Vault
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Store reusable key-value context in one place. Vault secrets stay in encrypted desktop
              storage and are not exposed to the model. Vault variables are intentionally exposed to
              the model so you can reference them without repeating yourself in every turn.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Secrets</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Safe desktop-only secrets. Use a friendly name as the key and paste the sensitive
                value once.
              </p>
            </div>
            {isElectron ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSecretRows((existingRows) => [
                    ...existingRows,
                    {
                      id: makeSecretRowId(),
                      key: "",
                      value: "",
                      persisted: false,
                      updatedAt: null,
                    },
                  ]);
                }}
              >
                <PlusIcon className="size-3.5" />
                Add secret
              </Button>
            ) : null}
          </div>

          {!isElectron ? (
            <div className="rounded-2xl border bg-card p-6">
              <Empty className="min-h-48">
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Desktop only</EmptyTitle>
                  <EmptyDescription>
                    Encrypted Vault secrets require the desktop app because the values stay in the
                    Electron main process and never enter normal settings.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="rounded-2xl border bg-card p-4">
              {!vaultSecrets.enabled ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 p-3 text-xs text-amber-700">
                  {vaultSecrets.message ??
                    "Encrypted secret storage is unavailable on this device."}
                </div>
              ) : null}

              {secretRows.length === 0 ? (
                <Empty className="min-h-48">
                  <EmptyMedia variant="icon">
                    <KeyRoundIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No secrets saved</EmptyTitle>
                    <EmptyDescription>
                      Example: key `my stripe api key`, value `sk-live-...`.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="space-y-3">
                  {secretRows.map((row) => {
                    const persistedSecret = persistedSecretById.get(row.id);
                    const isSaving = savingSecretIds[row.id] === true;
                    const isDeleting = deletingSecretIds[row.id] === true;
                    const keyChanged =
                      row.persisted && persistedSecret ? row.key !== persistedSecret.key : true;
                    const canSave =
                      row.key.trim().length > 0 &&
                      (!row.persisted || row.value.trim().length > 0 || keyChanged);

                    return (
                      <div
                        key={row.id}
                        className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_auto_auto]"
                      >
                        <label className="space-y-1">
                          <span className="text-xs font-medium text-foreground">Key</span>
                          <Input
                            value={row.key}
                            placeholder="my stripe api key"
                            onChange={(event) => {
                              setSecretRows((existingRows) =>
                                existingRows.map((entry) =>
                                  entry.id === row.id
                                    ? {
                                        ...entry,
                                        key: event.target.value,
                                      }
                                    : entry,
                                ),
                              );
                            }}
                            spellCheck={false}
                          />
                        </label>

                        <label className="space-y-1">
                          <span className="text-xs font-medium text-foreground">Value</span>
                          <Input
                            type="password"
                            value={row.value}
                            placeholder={
                              row.persisted ? "Replace secret value" : "Enter secret value"
                            }
                            onChange={(event) => {
                              setSecretRows((existingRows) =>
                                existingRows.map((entry) =>
                                  entry.id === row.id
                                    ? {
                                        ...entry,
                                        value: event.target.value,
                                      }
                                    : entry,
                                ),
                              );
                            }}
                            autoComplete="off"
                          />
                        </label>

                        <div className="flex items-end">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!canSave || isSaving || !vaultSecrets.enabled}
                            onClick={() => {
                              saveSecretRow(row.id);
                            }}
                          >
                            {isSaving ? "Saving..." : row.persisted ? "Save changes" : "Save"}
                          </Button>
                        </div>

                        <div className="flex items-end">
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={isDeleting}
                            onClick={() => {
                              deleteSecretRow(row.id);
                            }}
                          >
                            <Trash2Icon className="size-4" />
                            Delete
                          </Button>
                        </div>

                        <div className="lg:col-span-4 text-[11px] text-muted-foreground">
                          {row.persisted
                            ? row.updatedAt
                              ? `${formatUpdatedAt(row.updatedAt)} | Stored value: ********`
                              : "Stored value: ********"
                            : "Not saved yet"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Variables</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Model-visible key-value context. Use variables for details you want the model to
                remember and substitute when you reference the key.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setVariableRows((existingRows) => [
                  ...existingRows,
                  {
                    id: makeVariableRowId(),
                    key: "",
                    value: "",
                    persisted: false,
                  },
                ]);
              }}
            >
              <PlusIcon className="size-3.5" />
              Add variable
            </Button>
          </div>

          <div className="rounded-2xl border bg-card p-4">
            {variableRows.length === 0 ? (
              <Empty className="min-h-48">
                <EmptyMedia variant="icon">
                  <Settings2Icon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No variables saved</EmptyTitle>
                  <EmptyDescription>
                    Example: key `my work email`, value `you@example.com`.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-3">
                {variableRows.map((row) => {
                  const persistedVariable = persistedVariableById.get(row.id);
                  const keyChanged =
                    row.persisted && persistedVariable ? row.key !== persistedVariable.key : true;
                  const valueChanged =
                    row.persisted && persistedVariable
                      ? row.value !== persistedVariable.value
                      : true;

                  return (
                    <div
                      key={row.id}
                      className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto_auto]"
                    >
                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Key</span>
                        <Input
                          value={row.key}
                          placeholder="my work email"
                          onChange={(event) => {
                            setVariableRows((existingRows) =>
                              existingRows.map((entry) =>
                                entry.id === row.id
                                  ? {
                                      ...entry,
                                      key: event.target.value,
                                    }
                                  : entry,
                              ),
                            );
                          }}
                          spellCheck={false}
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-medium text-foreground">Value</span>
                        <Input
                          value={row.value}
                          placeholder="you@example.com"
                          onChange={(event) => {
                            setVariableRows((existingRows) =>
                              existingRows.map((entry) =>
                                entry.id === row.id
                                  ? {
                                      ...entry,
                                      value: event.target.value,
                                    }
                                  : entry,
                              ),
                            );
                          }}
                          spellCheck={false}
                        />
                      </label>

                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            row.key.trim().length === 0 ||
                            row.value.trim().length === 0 ||
                            (row.persisted && !keyChanged && !valueChanged)
                          }
                          onClick={() => {
                            saveVariableRow(row.id);
                          }}
                        >
                          {row.persisted ? "Save changes" : "Save"}
                        </Button>
                      </div>

                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            deleteVariableRow(row.id);
                          }}
                        >
                          <Trash2Icon className="size-4" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
