import { useAtomValue } from "@effect/atom-react";
import { useId, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import {
  type DeviceEasAccount,
  type EasDeviceHostConfig,
  type EnvironmentId,
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
import { SecretInput } from "./SecretInput";

const FROM_THREAD_PROJECT = "thread-project";

const CREDENTIAL_SOURCES: Record<DeviceEasAccount["credentialSource"], string> = {
  settings: "the access token saved here",
  env: "EXPO_TOKEN on the server",
  "eas-login": "the server's eas login",
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
  const check = useAtomCommand(deviceEnvironment.easAccount, { reportFailure: false });
  const [draft, setDraft] = useState(props.host);
  const tokenId = useId();
  // A saved token arrives redacted; only a replacement or a clear changes it.
  const [token, setToken] = useState<
    { kind: "saved" } | { kind: "new"; value: string } | { kind: "cleared" }
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
  const valid = Option.isSome(parseEasDeviceHostDraft(next));
  // Why Save is off, for the limits the fields' ranges do not show.
  const problem = valid
    ? null
    : draft.maxSessionMinutes > 0 && draft.idleMinutes >= draft.maxSessionMinutes
      ? "Idle minutes must be smaller than session minutes."
      : "Give the host a label and limits within the ranges shown.";
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
            <DialogTitle>{props.isNew ? "Add EAS host" : "Edit EAS host"}</DialogTitle>
            <DialogDescription>
              The environment's server signs in to Expo and starts the sessions. Without a token
              here it uses EXPO_TOKEN, then its eas login.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
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
                Expo access token
              </label>
              <div className="flex items-center gap-2">
                <SecretInput
                  id={tokenId}
                  className="min-w-0 flex-1"
                  configured={token.kind === "saved"}
                  value={token.kind === "new" ? token.value : ""}
                  disabled={props.busy}
                  placeholder="Optional"
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
                    aria-label="Clear access token"
                    onClick={() => {
                      setToken({ kind: "cleared" });
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
                  ? `Signed in as ${account.account.signedInAs} with ${CREDENTIAL_SOURCES[account.account.credentialSource]}.`
                  : account.status === "failed"
                    ? account.error
                    : account.status === "checking"
                      ? "Checking the Expo account…"
                      : "Check the Expo account before choosing a project."}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.busy || account.status === "checking"}
                onClick={() => void checkAccount()}
              >
                {account.status === "checking" ? <Spinner size="xs" /> : null} Check account
              </Button>
            </div>
            <div className="space-y-1.5 text-sm">
              <span>EAS project</span>
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
                <SelectTrigger size="sm" aria-label="EAS project">
                  <SelectValue>
                    {(value: string) =>
                      value === FROM_THREAD_PROJECT
                        ? "From the thread's project"
                        : (apps.find((app) => app.id === value)?.fullName ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={FROM_THREAD_PROJECT}>From the thread's project</SelectItem>
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
                Sessions bill the project's Expo account. "From the thread's project" reads
                extra.eas.projectId from the project's app config.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {limit("maxConcurrentSessions", "Sessions at once", 20)}
              {limit("maxSessionMinutes", "Session minutes", 115)}
              {limit("idleMinutes", "Idle minutes", 60)}
            </div>
            <p className="text-xs text-muted-foreground">
              Expo allows sessions of up to 40 minutes on free accounts and 115 on paid ones, and
              ends one after the idle minutes without activity, so idle minutes must be smaller than
              session minutes.
              {props.isNew ? null : " Saving restarts this host, which stops its running sessions."}
            </p>
            {problem === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || !valid}>
              {props.busy ? <Spinner size="xs" /> : null} Save host
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
