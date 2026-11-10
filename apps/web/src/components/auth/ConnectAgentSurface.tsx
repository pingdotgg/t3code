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

import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { cn } from "~/lib/utils";
import {
  agentRedirectUrl,
  resolveApprovalDecision,
  resolveMcpAccess,
} from "./ConnectAgentSurface.logic";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useT } from "~/hooks/useI18n";
import { translateNow } from "~/lib/miscTranslateNow";
import type { MessageKey } from "@t3tools/client-runtime/i18n";

export const accessConfig: Record<
  AuthMcpClientAccess,
  {
    readonly label: string;
    readonly description: string;
    readonly labelKey: MessageKey;
    readonly descriptionKey: MessageKey;
    readonly icon: LucideIcon;
  }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
    labelKey: "misc.auth.agent.readOnly.label",
    descriptionKey: "misc.auth.agent.readOnly.description",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

const ARM_DELAY_MS = 700;

function followRedirect(url: string): boolean {
  const safe = agentRedirectUrl(url);
  if (safe !== null) window.location.replace(safe);
  return safe !== null;
}

function redirectsToThisComputer(redirectHost: string): boolean {
  return isLoopbackHost(new URL(`http://${redirectHost}`).hostname);
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

const isApprovalError = Schema.is(AuthMcpApprovalError);

export type McpApprovalAnswer<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "error"; readonly message: string };

/** Where the consent page reads the sign-in request and sends the decision. */
export interface McpApprovalTransport {
  readonly load: (
    authorization: AuthMcpAuthorizationRequest,
  ) => Promise<McpApprovalAnswer<AuthMcpApprovalDetails>>;
  readonly decide: (
    authorization: AuthMcpAuthorizationRequest,
    decision: AuthMcpApprovalDecision,
  ) => Promise<McpApprovalAnswer<unknown>>;
}

function runApproval<A>(
  call: (
    client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>,
  ) => Effect.Effect<A | { readonly redirectTo: string }, unknown>,
): Promise<McpApprovalAnswer<A>> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap(call),
      Effect.map((value): McpApprovalAnswer<A> =>
        typeof value === "object" && value !== null && "redirectTo" in value
          ? { kind: "redirect", url: value.redirectTo }
          : { kind: "ok", value: value as A },
      ),
      Effect.catch((error) =>
        Effect.succeed<McpApprovalAnswer<A>>({
          kind: "error",
          message: isApprovalError(error)
            ? error.message
            : translateNow("misc.auth.agent.unreachable"),
        }),
      ),
    ),
  ).catch((): McpApprovalAnswer<A> => ({
    kind: "error",
    message: translateNow("misc.auth.agent.unreachable"),
  }));
}

/** This environment's own page, approving with a code or this browser's session. */
const primaryTransport: McpApprovalTransport = {
  load: (authorization) =>
    runApproval((client) => client.mcpOAuth.approval({ headers: {}, payload: authorization })),
  decide: (authorization, decision) =>
    runApproval((client) =>
      client.mcpOAuth.decision({ headers: {}, payload: { authorization, decision } }),
    ),
};

const decodeAuthorizationRequest = Schema.decodeSync(AuthMcpAuthorizationRequest);

/** The agent's OAuth request from this page's query; other parameters are ignored. */
export function readAuthorizationRequest(): AuthMcpAuthorizationRequest {
  return decodeAuthorizationRequest(Object.fromEntries(new URL(window.location.href).searchParams));
}

export function ConnectAgentSurface() {
  const [authorization] = useState(readAuthorizationRequest);
  return <McpConsent authorization={authorization} transport={primaryTransport} acceptsCode />;
}

/**
 * The consent screen for one agent sign-in. `acceptsCode` shows the sign-in code field;
 * `requireLevelChoice` starts with no level picked; `footer` sits under the actions.
 */
export function McpConsent({
  authorization,
  transport,
  acceptsCode = false,
  requireLevelChoice = false,
  environmentLabel,
  footer,
}: {
  readonly authorization: AuthMcpAuthorizationRequest;
  readonly transport: McpApprovalTransport;
  readonly acceptsCode?: boolean;
  readonly requireLevelChoice?: boolean;
  readonly environmentLabel?: string | undefined;
  readonly footer?: ReactNode;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [requestedAccess, setAccess] = useState<AuthMcpClientAccess | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [armed, setArmed] = useState(false);
  const access =
    requireLevelChoice && requestedAccess === null
      ? null
      : resolveMcpAccess(
          requestedAccess,
          loaded.status === "ready" ? loaded.details.runtimeModeCeiling : undefined,
          pairingCode.trim().length > 0,
        );
  const [errorMessage, setErrorMessage] = useState("");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the MCP OAuth approval and redirects the window or stores details, ignoring stale answers
  useEffect(() => {
    let cancelled = false;
    void transport.load(authorization).then((answer) => {
      if (cancelled) return;
      if (answer.kind === "redirect") {
        if (!followRedirect(answer.url)) {
          setLoaded({ status: "invalid", message: translateNow("misc.auth.agent.unsafeRedirect") });
        }
        return;
      }
      setLoaded(
        answer.kind === "error"
          ? { status: "invalid", message: answer.message }
          : { status: "ready", details: answer.value },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [authorization, transport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps Approve off briefly after the page shows or regains focus, so a click aimed at another window cannot land on it
  useEffect(() => {
    if (loaded.status !== "ready") return;
    let timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    const rearm = () => {
      setArmed(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    };
    window.addEventListener("focus", rearm);
    document.addEventListener("visibilitychange", rearm);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", rearm);
      document.removeEventListener("visibilitychange", rearm);
    };
  }, [loaded.status]);

  const decide = async (choice: "approve" | "deny", details: AuthMcpApprovalDetails) => {
    const decision: AuthMcpApprovalDecision | null =
      choice === "deny"
        ? { _tag: "deny" }
        : access === null
          ? null
          : resolveApprovalDecision({ code: pairingCode, access, details });
    if (decision === null) return;
    setPending(choice);
    setErrorMessage("");
    const answer = await transport.decide(authorization, decision);
    if (answer.kind === "redirect" && followRedirect(answer.url)) return;
    setPending(null);
    setErrorMessage(
      answer.kind === "error"
        ? answer.message
        : answer.kind === "redirect"
          ? t("misc.auth.agent.unsafeRedirect")
          : t("misc.auth.agent.signInCannotContinue"),
    );
  };

  if (loaded.status === "loading") {
    return (
      <StandalonePage>
        <ConnectAgentHeading
          title={t("misc.auth.agent.checking.title")}
          description={t("misc.auth.agent.checking.description")}
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </StandalonePage>
    );
  }

  if (loaded.status === "invalid") {
    return (
      <StandalonePage>
        <ConnectAgentHeading
          title={t("misc.auth.agent.invalid.title")}
          description={loaded.message}
        />
        <p className="mt-4 text-sm text-muted-foreground">{t("misc.auth.agent.invalid.body")}</p>
        {footer}
      </StandalonePage>
    );
  }

  const { details } = loaded;
  const canApprove =
    armed &&
    pending === null &&
    access !== null &&
    resolveApprovalDecision({ code: pairingCode, access, details }) !== null;
  // A code from "Use T3 Code in another app" names its level, so the page does not ask again.
  const codeAccess = parseMcpApprovalCode(pairingCode)?.access;
  const approveLevel = codeAccess ?? access;

  return (
    <StandalonePage>
      <ConnectAgentHeading
        title={t("misc.auth.agent.connectTitle", { name: details.clientName })}
        description={
          <>
            {t("misc.auth.agent.wantsBefore")}
            <span className="font-medium text-foreground">
              {environmentLabel ?? details.environmentHost}
            </span>
            {environmentLabel ? ` (${details.environmentHost})` : null}
            {t("misc.auth.agent.wantsAfter")}
          </>
        }
      />
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("misc.auth.agent.details.app")}</dt>
        <dd className="min-w-0 break-words">
          {details.clientName}{" "}
          <span className="text-muted-foreground">{t("misc.auth.agent.details.appNameNote")}</span>
        </dd>
        <dt className="text-muted-foreground">{t("misc.auth.agent.details.accessGoesTo")}</dt>
        <dd className="min-w-0 break-words font-medium">
          {details.redirectHost}
          {redirectsToThisComputer(details.redirectHost) ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              {t("misc.auth.agent.details.localNote")}
            </span>
          ) : (
            <span className="font-normal text-muted-foreground">
              {" "}
              {t("misc.auth.agent.details.remoteNote")}
            </span>
          )}
        </dd>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{t("misc.auth.agent.onlyApprove")}</p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve", details);
        }}
      >
        {acceptsCode ? (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="connect-agent-pairing-code">
              {t("misc.auth.agent.pairingCode")}
            </label>
            <Input
              id="connect-agent-pairing-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={pending !== null}
              nativeInput
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              placeholder={t("misc.auth.agent.pairingCodePlaceholder")}
              spellCheck={false}
              value={pairingCode}
            />
            <p className="text-xs text-muted-foreground">
              {t("misc.auth.agent.pairingCodeHelpBefore")}
              <code>t3 auth pairing create</code>
              {t("misc.auth.agent.pairingCodeHelpAfter")}
            </p>
          </div>
        ) : null}

        {codeAccess ? (
          <p className="text-sm">
            <span className="text-muted-foreground">{t("misc.auth.agent.access")}</span>{" "}
            <span className="font-medium">{t(accessConfig[codeAccess].labelKey)}</span>
          </p>
        ) : (
          <div className="space-y-2">
            <span id="connect-agent-access-label" className="text-sm font-medium">
              {t("misc.auth.agent.whatItMayDo")}
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
            <p className="text-xs text-muted-foreground">{t("misc.auth.agent.accessNote")}</p>
          </div>
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} type="submit">
            {pending === "approve"
              ? t("misc.auth.agent.approving")
              : approveLevel === null
                ? t("misc.auth.agent.chooseAccess")
                : t("misc.auth.agent.approveLevel", {
                    level: t(accessConfig[approveLevel].labelKey),
                  })}
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny", details)}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? t("misc.auth.agent.denying") : t("misc.auth.agent.deny")}
          </Button>
        </div>
      </form>
      {footer}
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
  const t = useT();
  return (
    <StandalonePageHeader
      context={t("misc.auth.agent.context")}
      title={title}
      description={description}
    />
  );
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
  const t = useT();
  const { labelKey, descriptionKey, icon: Icon } = accessConfig[access];
  const label = t(labelKey);
  const detail = disabledReason ?? (description === undefined ? t(descriptionKey) : description);
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
