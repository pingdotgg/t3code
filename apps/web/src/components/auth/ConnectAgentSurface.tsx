import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpClientAccess,
  AuthMcpAuthorizationRequest,
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  parseMcpApprovalCode,
} from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { EyeIcon, type LucideIcon } from "lucide-react";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";

import {
  approveAgentUrl,
  clearPendingApproval,
  newApprovalNonce,
  pendingValue,
  readConnectApprovalReturn,
  readPendingApproval,
  rememberPendingApproval,
} from "~/cloud/connectAgentApproval";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { cn } from "~/lib/utils";
import { resolveApprovalDecision, resolveMcpAccess } from "./ConnectAgentSurface.logic";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export const accessConfig: Record<
  AuthMcpClientAccess,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

function redirectsToThisComputer(redirectHost: string): boolean {
  return isLoopbackHost(new URL(`http://${redirectHost}`).hostname);
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

const UNREACHABLE = "Could not reach this environment. Try again.";
const isApprovalError = Schema.is(AuthMcpApprovalError);

type Answer<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "error"; readonly message: string };

function runApproval<A>(
  call: (
    client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>,
  ) => Effect.Effect<A | { readonly redirectTo: string }, unknown>,
): Promise<Answer<A>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap(call),
      Effect.map((value): Answer<A> =>
        typeof value === "object" && value !== null && "redirectTo" in value
          ? { kind: "redirect", url: value.redirectTo }
          : { kind: "ok", value: value as A },
      ),
      Effect.catch((error) =>
        Effect.succeed<Answer<A>>({
          kind: "error",
          message: isApprovalError(error) ? error.message : UNREACHABLE,
        }),
      ),
    ),
  ).catch((): Answer<A> => ({ kind: "error", message: UNREACHABLE }));
}

/** Sends the decision and follows its redirect; otherwise the message to show. */
async function submitDecision(
  authorization: AuthMcpAuthorizationRequest,
  decision: AuthMcpApprovalDecision,
): Promise<string | null> {
  const answer = await runApproval((client) =>
    client.mcpOAuth.decision({ payload: { authorization, decision } }),
  );
  if (answer.kind === "redirect") {
    window.location.replace(answer.url);
    return null;
  }
  return answer.kind === "error" ? answer.message : "The sign-in could not continue.";
}

const decodeAuthorizationRequest = Schema.decodeSync(AuthMcpAuthorizationRequest);

function readAuthorizationRequest(): AuthMcpAuthorizationRequest {
  return decodeAuthorizationRequest(Object.fromEntries(new URL(window.location.href).searchParams));
}

export function ConnectAgentSurface() {
  const [authorization] = useState(readAuthorizationRequest);
  const [connectReturn] = useState(() =>
    readConnectApprovalReturn(window.location.hash, window.location.search, readPendingApproval()),
  );
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [requestedAccess, setAccess] = useState<AuthMcpClientAccess | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const access = resolveMcpAccess(
    requestedAccess,
    loaded.status === "ready" ? loaded.details.runtimeModeCeiling : undefined,
    pairingCode.trim().length > 0,
  );
  const [errorMessage, setErrorMessage] = useState(
    connectReturn.status === "discarded"
      ? "The T3 Connect approval did not come back to the tab that started it, so it was not used. Try again here, or paste a sign-in code."
      : "",
  );
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the MCP OAuth approval and redirects the window or stores details, ignoring stale answers
  useEffect(() => {
    let cancelled = false;
    // The code is one-use; keep it out of history, bookmarks and a reload.
    if (connectReturn.status !== "none") {
      clearPendingApproval();
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    void runApproval((client) => client.mcpOAuth.approval({ payload: authorization })).then(
      (answer) => {
        if (cancelled) return;
        if (answer.kind === "redirect") {
          window.location.replace(answer.url);
          return;
        }
        if (answer.kind === "error") {
          setLoaded({ status: "invalid", message: answer.message });
          return;
        }
        setLoaded({ status: "ready", details: answer.value });
        // This tab chose the app and level before leaving for T3 Connect, so that was the approval.
        const decision =
          connectReturn.status === "approved"
            ? resolveApprovalDecision({
                code: connectReturn.code,
                access: "read-only",
                details: answer.value,
              })
            : null;
        if (decision === null) return;
        setPending("approve");
        void submitDecision(authorization, decision).then((message) => {
          if (cancelled || message === null) return;
          setPending(null);
          setErrorMessage(message);
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authorization, connectReturn]);

  const continueWithConnect = (connect: NonNullable<AuthMcpApprovalDetails["connectSignIn"]>) => {
    const nonce = newApprovalNonce();
    rememberPendingApproval(pendingValue(nonce, access, window.location.search));
    window.location.assign(
      approveAgentUrl(connect.hostedAppUrl, {
        environmentId: connect.environmentId,
        access,
        nonce,
        returnTo: `${window.location.origin}${window.location.pathname}${window.location.search}`,
      }),
    );
  };

  const decide = async (choice: "approve" | "deny", details: AuthMcpApprovalDetails) => {
    const decision: AuthMcpApprovalDecision | null =
      choice === "deny"
        ? { _tag: "deny" }
        : resolveApprovalDecision({ code: pairingCode, access, details });
    if (decision === null) return;
    setPending(choice);
    setErrorMessage("");
    const message = await submitDecision(authorization, decision);
    if (message === null) return;
    setPending(null);
    setErrorMessage(message);
  };

  if (loaded.status === "loading") {
    return (
      <StandalonePage>
        <ConnectAgentHeading
          title="Checking the sign-in request"
          description="One moment while this environment verifies the agent's request."
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </StandalonePage>
    );
  }

  if (loaded.status === "invalid") {
    return (
      <StandalonePage>
        <ConnectAgentHeading title="This sign-in cannot continue" description={loaded.message} />
        <p className="mt-4 text-sm text-muted-foreground">
          Close this page and start the sign-in again from your agent.
        </p>
      </StandalonePage>
    );
  }

  const { details } = loaded;
  const canDecide = resolveApprovalDecision({ code: pairingCode, access, details }) !== null;
  const canApprove = pending === null && canDecide;
  // A typed code or a browser session that can approve takes precedence.
  const connectSignIn =
    pairingCode.trim().length === 0 && !canDecide ? details.connectSignIn : undefined;
  // A code from "Use T3 Code in another app" names its level, so the page does not ask again.
  const codeAccess = parseMcpApprovalCode(pairingCode)?.access;
  const codeField = (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="connect-agent-pairing-code">
        {details.connectSignIn ? "Or paste a sign-in code" : "Sign-in code"}
      </label>
      <Input
        id="connect-agent-pairing-code"
        autoCapitalize="none"
        autoComplete="one-time-code"
        autoCorrect="off"
        disabled={pending !== null}
        nativeInput
        onChange={(event) => setPairingCode(event.currentTarget.value)}
        placeholder="Paste a code"
        spellCheck={false}
        value={pairingCode}
      />
      <p className="text-xs text-muted-foreground">
        Get one from Use T3 Code in another app (MCP), Settings → Sharing & access, or{" "}
        <code>t3 auth pairing create</code> on this machine.
      </p>
    </div>
  );

  return (
    <StandalonePage>
      <ConnectAgentHeading
        title={`Connect ${details.clientName}`}
        description={
          <>
            This agent wants to use the threads in every project on{" "}
            <span className="font-medium text-foreground">{details.environmentHost}</span>.
          </>
        }
      />
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">App</dt>
        <dd className="min-w-0 break-words">
          {details.clientName} <span className="text-muted-foreground">· name set by the app</span>
        </dd>
        <dt className="text-muted-foreground">Access goes to</dt>
        <dd className="min-w-0 break-words font-medium">
          {details.redirectHost}
          {redirectsToThisComputer(details.redirectHost) ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              on the computer that opened this page
            </span>
          ) : null}
        </dd>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">Only approve a sign-in you just started.</p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve", details);
        }}
      >
        {details.connectSignIn ? null : codeField}

        {codeAccess ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Access</span>{" "}
            <span className="font-medium">{accessConfig[codeAccess].label}</span>
          </p>
        ) : (
          <div className="space-y-2">
            <span id="connect-agent-access-label" className="text-sm font-medium">
              What it may do
            </span>
            <RadioGroup
              aria-labelledby="connect-agent-access-label"
              value={access}
              onValueChange={(value) => setAccess(value as AuthMcpClientAccess)}
            >
              {AuthMcpClientAccess.literals.map((option) => (
                <AccessOption
                  key={option}
                  access={option}
                  selected={option === access}
                  disabledReason={ceilingReason(details, option)}
                />
              ))}
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              Beyond read only, it can start, message and stop threads, and none of them can run
              with more than the mode you pick.
            </p>
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {connectSignIn ? (
            <Button
              disabled={pending !== null}
              onClick={() => continueWithConnect(connectSignIn)}
              type="button"
            >
              {pending === "approve"
                ? "Approving…"
                : `Approve ${accessConfig[access].label} with T3 Connect`}
            </Button>
          ) : (
            <Button disabled={!canApprove} type="submit">
              {pending === "approve"
                ? "Approving…"
                : codeAccess
                  ? `Approve ${accessConfig[codeAccess].label}`
                  : "Approve"}
            </Button>
          )}
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny", details)}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
        </div>

        {details.connectSignIn ? codeField : null}
      </form>
    </StandalonePage>
  );
}

function ConnectAgentHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return <StandalonePageHeader context="Agent sign-in" title={title} description={description} />;
}

/** Why a managed policy keeps `access` from being granted, or undefined when it may be. */
function ceilingReason(details: AuthMcpApprovalDetails, access: AuthMcpClientAccess) {
  const ceiling = details.runtimeModeCeiling;
  return ceiling === undefined ||
    access === "read-only" ||
    !isRuntimeModeAbove(access, ceiling.maxRuntimeMode)
    ? undefined
    : managedRuntimeModeCeilingMessage(ceiling.organization, ceiling.maxRuntimeMode);
}

/** One access level in a radio group; `description` replaces the level's own, null hides it. */
export function AccessOption({
  access,
  selected,
  disabledReason,
  description,
}: {
  readonly access: AuthMcpClientAccess;
  readonly selected: boolean;
  readonly disabledReason: string | undefined;
  readonly description?: string | null;
}) {
  const { label, icon: Icon } = accessConfig[access];
  const detail =
    disabledReason ?? (description === undefined ? accessConfig[access].description : description);
  return (
    <RadioPrimitive.Root
      value={access}
      disabled={disabledReason !== undefined}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-background ring-2 ring-inset ring-primary/25 dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
          : "border-border bg-background hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {detail === null ? null : (
          <span className="block text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
    </RadioPrimitive.Root>
  );
}
