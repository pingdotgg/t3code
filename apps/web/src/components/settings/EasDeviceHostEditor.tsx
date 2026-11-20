import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages } from "gt-react";
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

const SIGNED_IN_MESSAGES: Record<DeviceEasAccount["credentialSource"], string> = {
  settings: msg("Signed in as {account} with the access token saved here."),
  env: msg("Signed in as {account} with EXPO_TOKEN on the server."),
  "eas-login": msg("Signed in as {account} with the server's eas login."),
};

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error
    ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
    : String(error);
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
  const gt = useGT();
  const m = useMessages();
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
      ? gt("Enter a valid secret reference.")
      : draft.maxSessionMinutes > 0 && draft.idleMinutes >= draft.maxSessionMinutes
        ? gt("Idle minutes must be smaller than session minutes.")
        : gt("Give the host a label and limits within the ranges shown.");
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
            <DialogTitle>{props.isNew ? gt("Add Expo host") : gt("Edit Expo host")}</DialogTitle>
            <DialogDescription>
              <T>
                The environment's server signs in to Expo and starts the sessions. Without a token
                here it uses EXPO_TOKEN, then its eas login.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>
                <T>Name</T>
              </span>
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
                <T>Expo access token</T>
              </label>
              <div className="flex items-center gap-2">
                <SecretSourceInput
                  key={tokenInputKey}
                  id={tokenId}
                  aria-label={gt("Expo access token")}
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
                  environmentId={props.environmentId}
                  onValidityChange={(valid) => {
                    setTokenValid(valid);
                    resetAccount();
                  }}
                  onSecretChange={(secret) => {
                    setToken(secret ? { kind: "new", value: secret } : { kind: "cleared" });
                    resetAccount();
                  }}
                  disabled={props.busy}
                  placeholder={gt("Optional")}
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
                    aria-label={gt("Clear access token")}
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
                  ? m(SIGNED_IN_MESSAGES[account.account.credentialSource], {
                      account: account.account.signedInAs,
                    })
                  : account.status === "failed"
                    ? account.error
                    : account.status === "checking"
                      ? gt("Checking the Expo account…")
                      : gt("Check the Expo account before choosing a project.")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.busy || !tokenValid || account.status === "checking"}
                onClick={() => void checkAccount()}
              >
                {account.status === "checking" ? <Spinner size="xs" /> : null} <T>Check account</T>
              </Button>
            </div>
            <div className="space-y-1.5 text-sm">
              <span>
                <T>Expo project</T>
              </span>
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
                <SelectTrigger size="sm" aria-label={gt("Expo project")}>
                  <SelectValue>
                    {(value: string) =>
                      value === FROM_THREAD_PROJECT
                        ? gt("From the thread's project")
                        : (apps.find((app) => app.id === value)?.fullName ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={FROM_THREAD_PROJECT}>
                    <T>From the thread's project</T>
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
                <T>
                  Sessions bill the project's Expo account. "From the thread's project" reads
                  extra.eas.projectId from the project's app config.
                </T>
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {limit("maxConcurrentSessions", gt("Sessions at once"), 20)}
              {limit("maxSessionMinutes", gt("Session minutes"), 115)}
              {limit("idleMinutes", gt("Idle minutes"), 60)}
            </div>
            <p className="text-xs text-muted-foreground">
              <T>
                Expo Simulators needs a paid Expo account. A session runs for up to 115 minutes and
                stops early when it is idle for the idle minutes, so idle minutes must be less than
                session minutes.
              </T>
              {props.isNew ? null : (
                <>
                  {" "}
                  <T>Saving restarts this host and stops its running sessions.</T>
                </>
              )}
            </p>
            {problem === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={props.busy || !valid}>
              {props.busy ? <Spinner size="xs" /> : null} <T>Save host</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
