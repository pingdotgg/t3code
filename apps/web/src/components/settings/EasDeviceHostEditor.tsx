import { useAtomValue } from "@effect/atom-react";
import { useId, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import {
  isSecretReference,
  type DeviceEasAccount,
  type EasDeviceHostConfig,
  type EnvironmentId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
import { deviceEasAccountCheck, deviceEnvironment } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { parseEasDeviceHostDraft } from "./easDeviceHostsSettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const FROM_THREAD_PROJECT = "thread-project";

const CREDENTIAL_SOURCES: Record<DeviceEasAccount["credentialSource"], MessageKey> = {
  settings: "settings.code.easEditor.sourceSettings",
  env: "settings.code.easEditor.sourceEnv",
  "eas-login": "settings.code.easEditor.sourceLogin",
};

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

type AccountCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "signed-in"; account: DeviceEasAccount }
  | { status: "failed"; error: string };

export function EasDeviceHostEditor(props: {
  environmentId: EnvironmentId;
  host: EasDeviceHostConfig;
  isNew: boolean;
  busy: boolean;
  onSave: (host: EasDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const t = useT();
  const check = useAtomCommand(deviceEnvironment.easAccount, { reportFailure: false });
  const [draft, setDraft] = useState(props.host);
  const tokenId = useId();
  const secretSources = useSecretSources(props.environmentId);
  const [tokenValid, setTokenValid] = useState(true);
  const [tokenInputKey, setTokenInputKey] = useState(0);
  // A saved token arrives redacted; only a replacement or a clear changes it.
  const [token, setToken] = useState<
    { kind: "saved" } | { kind: "new"; value: SettingsSecretValue } | { kind: "cleared" }
  >(props.host.accessToken ? { kind: "saved" } : { kind: "cleared" });
  // Checking on open names the saved project and shows a rejected credential
  // before anything is changed. A manual check or a token edit replaces it.
  const openCheck = useAtomValue(
    deviceEasAccountCheck({
      environmentId: props.environmentId,
      input: props.host.accessToken
        ? props.isNew
          ? {}
          : { hostId: props.host.id }
        : { accessToken: "" },
    }),
  );
  const [checked, setAccount] = useState<AccountCheck | null>(null);
  const account: AccountCheck =
    checked ??
    (openCheck._tag === "Initial" || openCheck.waiting
      ? { status: "checking" }
      : openCheck._tag === "Success"
        ? { status: "signed-in", account: openCheck.value }
        : { status: "failed", error: failureMessage(openCheck.cause) });
  const next: EasDeviceHostConfig = {
    ...draft,
    label: draft.label.trim(),
    accessToken:
      token.kind === "saved" ? props.host.accessToken : token.kind === "new" ? token.value : "",
  };
  const valid = tokenValid && Option.isSome(parseEasDeviceHostDraft(next));
  // Why Save is off, for the limits the fields' ranges do not show.
  const problem = valid
    ? null
    : !tokenValid
      ? t("settings.code.easEditor.problemToken")
      : draft.maxSessionMinutes > 0 && draft.idleMinutes >= draft.maxSessionMinutes
        ? t("settings.code.easEditor.problemIdle")
        : t("settings.code.easEditor.problemGeneral");
  const apps = account.status === "signed-in" ? account.account.apps : [];

  // A check answers for the credential it was asked about: a later check or a
  // token edit makes an earlier answer stale.
  const latestCheck = useRef(0);
  const resetAccount = () => {
    latestCheck.current++;
    setAccount({ status: "idle" });
  };
  const requestCheck = async () => {
    const run = ++latestCheck.current;
    const result = await check({
      environmentId: props.environmentId,
      input: {
        ...(token.kind === "saved" && !props.isNew ? { hostId: props.host.id } : {}),
        // A cleared token is sent as empty, so the check does not fall back to
        // the saved one that Save is about to drop.
        ...(token.kind === "new"
          ? { accessToken: token.value }
          : token.kind === "cleared"
            ? { accessToken: "" }
            : {}),
      },
    });
    if (run !== latestCheck.current) return;
    setAccount(
      result._tag === "Success"
        ? { status: "signed-in", account: result.value }
        : { status: "failed", error: failureMessage(result.cause) },
    );
  };
  const checkAccount = () => {
    setAccount({ status: "checking" });
    void requestCheck();
  };

  const limit = (
    field: "maxSessionMinutes" | "idleMinutes" | "maxConcurrentSessions",
    label: string,
    max: number,
  ) => (
    <label className="block space-y-1.5">
      <span>{label}</span>
      <Input
        type="number"
        min={1}
        max={max}
        value={draft[field]}
        disabled={props.busy}
        onChange={(event) => {
          const value = Number(event.target.value);
          setDraft((current) => ({ ...current, [field]: value }));
        }}
      />
    </label>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!props.busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !props.busy) props.onSave(next);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.isNew
                ? t("settings.code.easEditor.addTitle")
                : t("settings.code.easEditor.editTitle")}
            </DialogTitle>
            <DialogDescription>{t("settings.code.easEditor.description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>{t("settings.code.easEditor.name")}</span>
              <Input
                autoFocus
                required
                value={draft.label}
                disabled={props.busy}
                onChange={(event) => {
                  const label = event.target.value;
                  setDraft((current) => ({ ...current, label }));
                }}
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <label htmlFor={tokenId} className="block">
                {t("settings.code.easEditor.token")}
              </label>
              <div className="flex items-center gap-2">
                <SecretSourceInput
                  key={tokenInputKey}
                  id={tokenId}
                  aria-label="Expo access token"
                  className="min-w-0 flex-1"
                  configured={token.kind === "saved" && typeof props.host.accessToken === "string"}
                  value={
                    token.kind === "new"
                      ? token.value
                      : token.kind === "saved" && isSecretReference(props.host.accessToken)
                        ? props.host.accessToken
                        : ""
                  }
                  sources={secretSources}
                  onValidityChange={(valid) => {
                    setTokenValid(valid);
                    resetAccount();
                  }}
                  onSecretChange={(secret) => {
                    setToken(secret ? { kind: "new", value: secret } : { kind: "cleared" });
                    resetAccount();
                  }}
                  disabled={props.busy}
                  placeholder={t("settings.code.easEditor.optional")}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Emptying the field is not clearing the saved token; the
                    // Clear button is, so a saved token comes back here.
                    setToken(
                      value
                        ? { kind: "new", value }
                        : props.host.accessToken
                          ? { kind: "saved" }
                          : { kind: "cleared" },
                    );
                    resetAccount();
                  }}
                />
                {token.kind !== "cleared" ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label={t("settings.code.easEditor.clearToken")}
                    onClick={() => {
                      setToken({ kind: "cleared" });
                      setTokenValid(true);
                      setTokenInputKey((key) => key + 1);
                      resetAccount();
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
              <p role="status" className="min-w-0 text-xs text-muted-foreground">
                {account.status === "signed-in"
                  ? t("settings.code.easEditor.signedIn", {
                      account: account.account.signedInAs,
                      source: t(CREDENTIAL_SOURCES[account.account.credentialSource]),
                    })
                  : account.status === "failed"
                    ? account.error
                    : account.status === "checking"
                      ? t("settings.code.easEditor.checkingAccount")
                      : t("settings.code.easEditor.checkAccountHint")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.busy || !tokenValid || account.status === "checking"}
                onClick={() => void checkAccount()}
              >
                {account.status === "checking" ? <Spinner size="xs" /> : null}{" "}
                {t("settings.code.easEditor.checkAccount")}
              </Button>
            </div>
            <div className="space-y-1.5 text-sm">
              <span>{t("settings.code.easEditor.project")}</span>
              <Select
                value={draft.appId ?? FROM_THREAD_PROJECT}
                disabled={props.busy}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setDraft((current) => {
                    const { appId: _, ...rest } = current;
                    return value === FROM_THREAD_PROJECT ? rest : { ...rest, appId: value };
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("settings.code.easEditor.project")}>
                  <SelectValue>
                    {(value: string) =>
                      value === FROM_THREAD_PROJECT
                        ? t("settings.code.easEditor.fromThread")
                        : (apps.find((app) => app.id === value)?.fullName ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={FROM_THREAD_PROJECT}>
                    {t("settings.code.easEditor.fromThread")}
                  </SelectItem>
                  {draft.appId && !apps.some((app) => app.id === draft.appId) ? (
                    <SelectItem value={draft.appId}>{draft.appId}</SelectItem>
                  ) : null}
                  {apps.map((app) => (
                    <SelectItem key={app.id} value={app.id}>
                      {app.fullName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("settings.code.easEditor.projectHint")}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {limit("maxConcurrentSessions", t("settings.code.easEditor.sessionsAtOnce"), 20)}
              {limit("maxSessionMinutes", t("settings.code.easEditor.sessionMinutes"), 115)}
              {limit("idleMinutes", t("settings.code.easEditor.idleMinutes"), 60)}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.code.easEditor.limitsHint")}
              {props.isNew ? null : ` ${t("settings.code.easEditor.restartHint")}`}
            </p>
            {problem === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              {t("settings.code.easEditor.cancel")}
            </Button>
            <Button type="submit" disabled={props.busy || !valid}>
              {props.busy ? <Spinner size="xs" /> : null} {t("settings.code.easEditor.saveHost")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
