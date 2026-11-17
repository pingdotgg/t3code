import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BrowserLogin,
  BrowserLoginError,
  type BrowserLoginsList,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { KeyRoundIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
import { isMacPlatform } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  BROWSER_LOGIN_REASON_TEXT,
  describeFill,
  loginOriginOf,
} from "./PreviewLoginsButton.logic";

const isBrowserLoginError = Schema.is(BrowserLoginError);

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly url: string;
  /** An agent drives the tab, so a person must take control before filling. */
  readonly agentControls: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Whether the panel offers logins for this page: on, permitted, and an origin a login can fill. */
export function usePreviewLoginsAvailable(environmentId: EnvironmentId, url: string): boolean {
  const configured = useEnvironmentSettings(
    environmentId,
    (settings) => settings.browserLogins !== undefined,
  );
  const permitted = useAtomValue(previewEnvironment.listLogins.permissionAtom(environmentId));
  const supported =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.browserLogins === true;
  return configured && permitted && supported && loginOriginOf(url) !== null;
}

export function PreviewLoginsButton({
  environmentId,
  threadId,
  tabId,
  url,
  agentControls,
  open,
  onOpenChange,
}: Props) {
  const gt = useGT();
  const messages = useMessages();
  const origin = loginOriginOf(url);
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useEnvironmentSettings(environmentId, (value) => ({
    browserLogins: value.browserLogins,
    secretProviders: value.secretProviders,
  }));
  const listLogins = useAtomCommand(previewEnvironment.listLogins, { reportFailure: false });
  const fillLogin = useAtomCommand(previewEnvironment.fillLogin, { reportFailure: false });
  const [listed, setListed] = useState<{
    readonly key: string;
    readonly list: BrowserLoginsList | null;
    /** A `msg()` string, resolved where it renders so a language switch updates it. */
    readonly error: string | null;
  } | null>(null);
  const [filling, setFilling] = useState<string | null>(null);
  const listKey = [
    environmentId,
    tabId,
    origin ?? "",
    settings.browserLogins?.provider ?? "",
    settings.browserLogins?.vault ?? "",
  ].join("\u0000");
  const current = listed?.key === listKey ? listed : null;

  const load = useEffectEvent(async (key: string, isCancelled: () => boolean) => {
    const result = await listLogins({ environmentId, input: { threadId, tabId } });
    if (isCancelled() || isAtomCommandInterrupted(result)) return;
    if (result._tag === "Success") {
      setListed({ key, list: result.value, error: null });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setListed({
      key,
      list: null,
      error: isBrowserLoginError(error)
        ? BROWSER_LOGIN_REASON_TEXT[error.reason]
        : msg("Logins couldn't be listed."),
    });
  });
  // Only an open popover asks 1Password, so browsing never prompts on the server's machine.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the page origin's logins from the server
  useEffect(() => {
    if (origin === null || !open) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void load(listKey, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [listKey, origin, open]);

  if (origin === null) return null;
  const logins = current?.list?.logins ?? [];
  const host = URL.parse(origin)?.host ?? origin;
  const providerKind = settings.browserLogins
    ? settings.secretProviders[settings.browserLogins.provider]?.kind
    : undefined;
  const providerName =
    (providerKind && builtInSecretProviderDefinitions.find(providerKind)?.label) ??
    gt("Password manager");
  const ownerLabel =
    environmentId === primaryEnvironmentId
      ? isMacPlatform(navigator.platform)
        ? gt("{provider} on this Mac", { provider: providerName })
        : gt("{provider} on this computer", { provider: providerName })
      : gt("{provider} on {environment}", {
          provider: providerName,
          environment: environment?.label ?? gt("the environment"),
        });

  const fill = async (login: BrowserLogin, kind: "login" | "otp") => {
    setFilling(`${login.id}:${kind}`);
    const result = await fillLogin({
      environmentId,
      input: { threadId, tabId, itemId: login.id, fill: kind },
    });
    setFilling(null);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Success") {
      toastManager.add(describeFill(result.value, m));
      if (result.value.filled.length > 0) onOpenChange(false);
      return;
    }
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: m(msg("Login not filled")),
      description: m(
        isBrowserLoginError(error)
          ? BROWSER_LOGIN_REASON_TEXT[error.reason]
          : msg("The login couldn't be filled."),
      ),
    });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant={open ? "secondary" : "ghost"}
                  size="icon-xs"
                  type="button"
                  aria-label={gt("Logins for {host}", { host })}
                />
              }
            />
          }
        >
          <KeyRoundIcon />
        </TooltipTrigger>
        <TooltipPopup>
          <T>
            Fill a login from <Var>{providerName}</Var>
          </T>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="md" padding="compact">
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              <PopoverTitle>
                <T>
                  Logins for <Var>{host}</Var>
                </T>
              </PopoverTitle>
            </span>
            <Badge variant="outline" className="max-w-40 shrink-0">
              <span className="truncate">{ownerLabel}</span>
            </Badge>
          </div>
          {current === null ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading…</T>
            </p>
          ) : current.error !== null ? (
            <p className="text-sm text-muted-foreground">{messages(current.error)}</p>
          ) : logins.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>
                No login in this vault has <Var>{origin}</Var> as a website.
              </T>
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {logins.map((login) => {
                const canFillLogin =
                  login.fields.includes("username") || login.fields.includes("password");
                const canFillCode = login.fields.includes("otp");
                return (
                  <li key={login.id} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{login.title}</span>
                    {canFillCode ? <Badge variant="secondary">2FA</Badge> : null}
                    {canFillLogin ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={filling !== null || agentControls}
                        onClick={() => void fill(login, "login")}
                      >
                        <T>Fill login</T>
                      </Button>
                    ) : null}
                    {canFillCode ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={filling !== null || agentControls}
                        onClick={() => void fill(login, "otp")}
                      >
                        <T>Fill code</T>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {agentControls && logins.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>An agent controls this tab. Take control to fill a login.</T>
            </p>
          ) : null}
          {settings.browserLogins ? (
            <p className="truncate text-xs text-muted-foreground">
              <T>
                Vault: <Var>{settings.browserLogins.vault}</Var>
              </T>
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
