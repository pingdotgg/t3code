import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type ReactNode } from "react";
import type { EnvironmentId, SimlockDeviceHostConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { XIcon } from "lucide-react";

import { deviceSimlockIdentityCheck } from "../../state/device";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";

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
import { Spinner } from "../ui/spinner";
import { SecretInput } from "./SecretInput";
import {
  planSimlockDeviceHostSave,
  simlockDeviceHostProblem,
  type SimlockHostEnvironment,
  type SimlockTokenEntry,
} from "./simlockDeviceHostsSettings.logic";

import { useT } from "../../hooks/useI18n";

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** The gateway each environment's own agent-device points at, if any. */
const machineGatewaysAtom = environmentAtomList("web-simlock-machine-gateways", (environmentId) =>
  deviceSimlockIdentityCheck({ environmentId, input: {} }),
);

const NO_CHECK = Atom.make(AsyncResult.initial()).pipe(Atom.withLabel("simlock-identity:none"));

/** Shared fields once, then one agent token per environment: Simlock counts leases per token. */
export function SimlockDeviceHostEditor(props: {
  host: SimlockDeviceHostConfig;
  isNew: boolean;
  environments: ReadonlyArray<SimlockHostEnvironment>;
  busy: boolean;
  onSave: (
    host: SimlockDeviceHostConfig,
    tokens: ReadonlyMap<EnvironmentId, SimlockTokenEntry>,
  ) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(props.host);
  const [urlEdited, setUrlEdited] = useState(false);
  const machineGateways = useAtomValue(
    machineGatewaysAtom(
      environmentIdsKey(
        props.isNew ? props.environments.map((environment) => environment.environmentId) : [],
      ),
    ),
  );
  // A new host starts at the gateway an environment's agent-device already uses.
  const detectedUrl = machineGateways
    .map((result) => Option.getOrUndefined(AsyncResult.value(result))?.gatewayUrl)
    .find(Boolean);
  const gatewayUrl = urlEdited || draft.gatewayUrl ? draft.gatewayUrl : (detectedUrl ?? "");
  const savedToken = (environment: SimlockHostEnvironment) =>
    environment.hosts.some((host) => host.id === props.host.id && host.agentToken !== "");
  const [tokens, setTokens] = useState<ReadonlyMap<EnvironmentId, SimlockTokenEntry>>(
    () =>
      new Map(
        props.environments.map((environment) => [
          environment.environmentId,
          savedToken(environment) ? { kind: "saved" } : { kind: "cleared" },
        ]),
      ),
  );
  const next: SimlockDeviceHostConfig = {
    ...draft,
    label: draft.label.trim(),
    gatewayUrl: gatewayUrl.trim(),
  };
  const checkUrl = simlockDeviceHostProblem(next, t) === null ? next.gatewayUrl : null;
  const plan = planSimlockDeviceHostSave(props.environments, next, tokens, t);
  const problem = "problem" in plan ? plan.problem : null;
  const several = props.environments.length > 1;
  const [hintA = "", hintB = "", hintC = "", hintD = ""] = t(
    several ? "settings.code.simlockEditor.hintMany" : "settings.code.simlockEditor.hintOne",
    { cmd: "\u0001", tokenVar: "\u0002", urlVar: "\u0003" },
  ).split(/[\u0001\u0002\u0003]/);

  const limit = (
    field: "maxLeases" | "maxLeaseMinutes",
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="block space-y-1.5">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
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
            if (problem === null && !props.busy) props.onSave(next, tokens);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.isNew
                ? t("settings.code.simlockEditor.addTitle")
                : t("settings.code.simlockEditor.editTitle")}
            </DialogTitle>
            <DialogDescription>
              {several
                ? t("settings.code.simlockEditor.descriptionMany")
                : t("settings.code.simlockEditor.descriptionOne")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>{t("settings.code.simlockEditor.name")}</span>
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
            <label className="block space-y-1.5 text-sm">
              <span>{t("settings.code.simlockEditor.gatewayUrl")}</span>
              <Input
                required
                type="url"
                placeholder="https://gateway.example.ts.net:4700"
                value={gatewayUrl}
                disabled={props.busy}
                onChange={(event) => {
                  const gatewayUrl = event.target.value;
                  setUrlEdited(true);
                  setDraft((current) => ({ ...current, gatewayUrl }));
                }}
              />
            </label>
            <div className="space-y-3">
              {props.environments.map((environment) => (
                <SimlockTokenField
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                  hostId={props.isNew ? null : props.host.id}
                  gatewayUrl={checkUrl}
                  label={
                    several
                      ? t("settings.code.simlockEditor.agentTokenFor", { name: environment.label })
                      : t("settings.code.simlockEditor.agentToken")
                  }
                  token={tokens.get(environment.environmentId) ?? { kind: "cleared" }}
                  hasSaved={savedToken(environment)}
                  busy={props.busy}
                  onChange={(token) =>
                    setTokens((current) => new Map(current).set(environment.environmentId, token))
                  }
                />
              ))}
              <p className="text-xs text-muted-foreground">
                {hintA}
                <code>simlock --gateway token create --role agent</code>
                {hintB}
                <code>AGENT_DEVICE_DAEMON_AUTH_TOKEN</code>
                {hintC}
                <code>AGENT_DEVICE_DAEMON_BASE_URL</code>
                {hintD}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {limit("maxLeases", t("settings.code.simlockEditor.devicesAtOnce"), 1, 20)}
              {limit("maxLeaseMinutes", t("settings.code.simlockEditor.leaseMinutes"), 5, 240)}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.code.simlockEditor.leaseHint")}
              {props.isNew ? null : ` ${t("settings.code.simlockEditor.restartHint")}`}
            </p>
            {problem === null || !gatewayUrl ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              {t("settings.code.simlockEditor.cancel")}
            </Button>
            <Button type="submit" disabled={props.busy || problem !== null}>
              {props.busy ? <Spinner size="xs" /> : null}{" "}
              {t("settings.code.simlockEditor.saveHost")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SimlockTokenField(props: {
  environmentId: EnvironmentId;
  hostId: string | null;
  gatewayUrl: string | null;
  label: ReactNode;
  token: SimlockTokenEntry;
  hasSaved: boolean;
  busy: boolean;
  onChange: (token: SimlockTokenEntry) => void;
}) {
  const t = useT();
  const id = useId();
  const entered = props.token.kind === "new" ? props.token.value.trim() : "";
  // A cleared field asks about the machine's own token, which a blank one falls back to.
  const check = useAtomValue(
    props.gatewayUrl === null
      ? NO_CHECK
      : deviceSimlockIdentityCheck({
          environmentId: props.environmentId,
          input: {
            gatewayUrl: props.gatewayUrl,
            ...(entered
              ? { agentToken: entered }
              : props.token.kind === "saved" && props.hostId !== null
                ? { hostId: props.hostId }
                : {}),
          },
        }),
  );
  const identity = AsyncResult.isSuccess(check) ? check.value : null;
  const status =
    props.gatewayUrl === null ? null : check._tag === "Initial" || check.waiting ? (
      <span className="text-muted-foreground">{t("settings.code.simlockEditor.checking")}</span>
    ) : identity ? (
      <span className="text-muted-foreground">
        {identity.tokenSource === "env"
          ? t("settings.code.simlockEditor.usingMachineToken", { account: identity.signedInAs })
          : t("settings.code.simlockEditor.acceptedAs", { account: identity.signedInAs })}
      </span>
    ) : AsyncResult.isFailure(check) ? (
      <span
        className={props.token.kind === "cleared" ? "text-muted-foreground" : "text-destructive"}
      >
        {failureMessage(check.cause)}
      </span>
    ) : null;
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block">
        {props.label}
      </label>
      <div className="flex items-center gap-2">
        <SecretInput
          id={id}
          className="min-w-0 flex-1"
          configured={props.token.kind === "saved"}
          value={props.token.kind === "new" ? props.token.value : ""}
          disabled={props.busy}
          onChange={(event) => {
            const value = event.target.value;
            // Emptying the field is not clearing the saved token; the Clear
            // button is, so a saved token comes back here.
            props.onChange(
              value
                ? { kind: "new", value }
                : props.hasSaved
                  ? { kind: "saved" }
                  : { kind: "cleared" },
            );
          }}
        />
        {props.token.kind !== "cleared" ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={t("settings.code.simlockEditor.clearToken")}
            disabled={props.busy}
            onClick={() => props.onChange({ kind: "cleared" })}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {status ? <p className="text-xs">{status}</p> : null}
    </div>
  );
}
