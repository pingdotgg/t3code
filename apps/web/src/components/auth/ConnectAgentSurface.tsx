import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpClientAccess,
  AuthMcpAuthorizationRequest,
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
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
import { resolveMcpAccess } from "./ConnectAgentSurface.logic";
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

function redirectsToThisComputer(redirectHost: string): boolean {
  return isLoopbackHost(new URL(`http://${redirectHost}`).hostname);
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly details: AuthMcpApprovalDetails };

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
          message: isApprovalError(error)
            ? error.message
            : translateNow("misc.auth.agent.unreachable"),
        }),
      ),
    ),
  ).catch((): Answer<A> => ({
    kind: "error",
    message: translateNow("misc.auth.agent.unreachable"),
  }));
}

const decodeAuthorizationRequest = Schema.decodeSync(AuthMcpAuthorizationRequest);

function readAuthorizationRequest(): AuthMcpAuthorizationRequest {
  return decodeAuthorizationRequest(Object.fromEntries(new URL(window.location.href).searchParams));
}

/** Sessions can grant only scopes they hold. */
function oneClickApproves(details: AuthMcpApprovalDetails, access: AuthMcpClientAccess) {
  return details.csrfToken !== undefined && (details.oneClickAccess ?? []).includes(access);
}

export function ConnectAgentSurface() {
  const t = useT();
  const [authorization] = useState(readAuthorizationRequest);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [requestedAccess, setAccess] = useState<AuthMcpClientAccess>("auto");
  const access = resolveMcpAccess(
    requestedAccess,
    loaded.status === "ready" ? loaded.details.runtimeModeCeiling : undefined,
  );
  const [pairingCode, setPairingCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the MCP OAuth approval and redirects the window or stores details, ignoring stale answers
  useEffect(() => {
    let cancelled = false;
    void runApproval((client) => client.mcpOAuth.approval({ payload: authorization })).then(
      (answer) => {
        if (cancelled) return;
        if (answer.kind === "redirect") {
          window.location.replace(answer.url);
          return;
        }
        setLoaded(
          answer.kind === "error"
            ? { status: "invalid", message: answer.message }
            : { status: "ready", details: answer.value },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authorization]);

  const decide = async (choice: "approve" | "deny") => {
    if (loaded.status !== "ready") return;
    setPending(choice);
    setErrorMessage("");
    const { csrfToken } = loaded.details;
    const decision: AuthMcpApprovalDecision =
      choice === "deny"
        ? { _tag: "deny" }
        : csrfToken !== undefined && oneClickApproves(loaded.details, access)
          ? { _tag: "browser-session", access, csrfToken }
          : { _tag: "pairing-code", access, code: pairingCode.trim() };
    const answer = await runApproval((client) =>
      client.mcpOAuth.decision({ payload: { authorization, decision } }),
    );
    if (answer.kind === "redirect") {
      window.location.replace(answer.url);
      return;
    }
    setPending(null);
    setErrorMessage(
      answer.kind === "error" ? answer.message : t("misc.auth.agent.signInCannotContinue"),
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
      </StandalonePage>
    );
  }

  const { details } = loaded;
  const oneClick = oneClickApproves(details, access);
  const canApprove = pending === null && (oneClick || pairingCode.trim().length > 0);

  return (
    <StandalonePage>
      <ConnectAgentHeading
        title={t("misc.auth.agent.connectTitle", { name: details.clientName })}
        description={
          <>
            {t("misc.auth.agent.wantsBefore")}
            <span className="font-medium text-foreground">{details.environmentHost}</span>
            {t("misc.auth.agent.wantsAfter")}
          </>
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {redirectsToThisComputer(details.redirectHost) ? (
          t("misc.auth.agent.nameChosenLocal", { host: details.redirectHost })
        ) : (
          <>
            {t("misc.auth.agent.nameChosenRemoteBefore")}
            <span className="font-medium text-foreground">{details.redirectHost}</span>
            {t("misc.auth.agent.nameChosenRemoteAfter")}
          </>
        )}
      </p>

      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canApprove) void decide("approve");
        }}
      >
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
                managedReason={ceilingReason(details, option)}
              />
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">{t("misc.auth.agent.accessNote")}</p>
        </div>

        {oneClick ? null : (
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
        )}

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} type="submit">
            {pending === "approve" ? t("misc.auth.agent.approving") : t("misc.auth.agent.approve")}
          </Button>
          <Button
            disabled={pending !== null}
            onClick={() => void decide("deny")}
            type="button"
            variant="outline"
          >
            {pending === "deny" ? t("misc.auth.agent.denying") : t("misc.auth.agent.deny")}
          </Button>
        </div>
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

function AccessOption({
  access,
  selected,
  managedReason,
}: {
  readonly access: AuthMcpClientAccess;
  readonly selected: boolean;
  readonly managedReason: string | undefined;
}) {
  const t = useT();
  const { labelKey, descriptionKey, icon: Icon } = accessConfig[access];
  const label = t(labelKey);
  const description = t(descriptionKey);
  return (
    <RadioPrimitive.Root
      value={access}
      disabled={managedReason !== undefined}
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
        <span className="block text-xs text-muted-foreground">{managedReason ?? description}</span>
      </span>
    </RadioPrimitive.Root>
  );
}
