import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type ReactNode } from "react";
import {
  isSecretReference,
  type EnvironmentId,
  type SettingsSecretValue,
  type SimlockDeviceHostConfig,
} from "@t3tools/contracts";
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
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import {
  planSimlockDeviceHostSave,
  simlockDeviceHostProblem,
  type SimlockHostEnvironment,
  type SimlockTokenEntry,
} from "./simlockDeviceHostsSettings.logic";

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
  const savedValue = (environment: SimlockHostEnvironment) =>
    environment.hosts.find((host) => host.id === props.host.id)?.agentToken ?? "";
  const savedToken = (environment: SimlockHostEnvironment) => savedValue(environment) !== "";
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
  const checkUrl = simlockDeviceHostProblem(next) === null ? next.gatewayUrl : null;
  // Environments whose token field holds a secret reference that cannot be saved yet.
  const [invalidTokens, setInvalidTokens] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const plan = planSimlockDeviceHostSave(props.environments, next, tokens);
  const problem =
    "problem" in plan
      ? plan.problem
      : invalidTokens.size > 0
        ? "Enter a valid secret reference."
        : null;
  const several = props.environments.length > 1;

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
            <DialogTitle>{props.isNew ? "Add Simlock host" : "Edit Simlock host"}</DialogTitle>
            <DialogDescription>
              {several
                ? "Each selected environment's server leases devices from your Simlock gateway with its own agent token, and releases them when they close."
                : "The environment's server leases devices from your Simlock gateway and releases them when they close."}
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
            <label className="block space-y-1.5 text-sm">
              <span>Gateway URL</span>
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
                  label={several ? `Agent token · ${environment.label}` : "Agent token"}
                  token={tokens.get(environment.environmentId) ?? { kind: "cleared" }}
                  saved={savedValue(environment)}
                  busy={props.busy}
                  onChange={(token) =>
                    setTokens((current) => new Map(current).set(environment.environmentId, token))
                  }
                  onValidityChange={(valid) =>
                    setInvalidTokens((current) => {
                      const nextInvalid = new Set(current);
                      if (valid) nextInvalid.delete(environment.environmentId);
                      else nextInvalid.add(environment.environmentId);
                      return nextInvalid;
                    })
                  }
                />
              ))}
              <p className="text-xs text-muted-foreground">
                Leases, drives, and streams devices. Create one{several ? " per environment" : ""}{" "}
                with <code>simlock --gateway token create --role agent</code>, or leave it blank to
                add it later. A blank token uses the machine's{" "}
                <code>AGENT_DEVICE_DAEMON_AUTH_TOKEN</code> when its{" "}
                <code>AGENT_DEVICE_DAEMON_BASE_URL</code> is this gateway.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {limit("maxLeases", "Devices at once", 1, 20)}
              {limit("maxLeaseMinutes", "Lease minutes", 5, 240)}
            </div>
            <p className="text-xs text-muted-foreground">
              A lease ends after the lease minutes even while in use.
              {props.isNew ? null : " Saving restarts this host, which releases its devices."}
            </p>
            {problem === null || !gatewayUrl ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy || problem !== null}>
              {props.busy ? <Spinner size="xs" /> : null} Save host
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
  /** This environment's saved token: redacted when a literal, shown when a secret reference. */
  saved: SettingsSecretValue;
  busy: boolean;
  onChange: (token: SimlockTokenEntry) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const id = useId();
  const sources = useSecretSources(props.environmentId);
  const [inputKey, setInputKey] = useState(0);
  // Emptying the field or leaving a reference returns to a saved literal, never to a saved reference.
  const savedLiteral = typeof props.saved === "string" && props.saved !== "";
  const entered =
    props.token.kind !== "new"
      ? ""
      : typeof props.token.value === "string"
        ? props.token.value.trim()
        : props.token.value;
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
      <span className="text-muted-foreground">Checking…</span>
    ) : identity ? (
      <span className="text-muted-foreground">
        {identity.tokenSource === "env"
          ? `Using this machine's agent-device token (${identity.signedInAs}).`
          : `Accepted as ${identity.signedInAs}.`}
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
        <SecretSourceInput
          key={inputKey}
          id={id}
          aria-label="Agent token"
          className="min-w-0 flex-1"
          configured={props.token.kind === "saved" && typeof props.saved === "string"}
          value={
            props.token.kind === "new"
              ? props.token.value
              : props.token.kind === "saved" && isSecretReference(props.saved)
                ? props.saved
                : ""
          }
          sources={sources}
          onValidityChange={props.onValidityChange}
          onSecretChange={(secret) =>
            props.onChange(
              secret
                ? { kind: "new", value: secret }
                : savedLiteral
                  ? { kind: "saved" }
                  : { kind: "cleared" },
            )
          }
          disabled={props.busy}
          onChange={(event) => {
            const value = event.target.value;
            // Emptying the field is not clearing the saved token; the Clear button is.
            props.onChange(
              value
                ? { kind: "new", value }
                : savedLiteral
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
            aria-label="Clear agent token"
            disabled={props.busy}
            onClick={() => {
              props.onChange({ kind: "cleared" });
              props.onValidityChange(true);
              setInputKey((key) => key + 1);
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {status ? <p className="text-xs">{status}</p> : null}
    </div>
  );
}
