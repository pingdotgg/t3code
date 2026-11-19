import {
  type LinkedPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
} from "@t3tools/shared/promptLinks";
import { parseNewThreadLink, parseThreadLinkPrompt } from "@t3tools/shared/promptLinksCopy";
import { useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { MessageResolver } from "../../i18n/messages";

import { DESKTOP_DOWNLOAD_URL } from "~/projectLinks";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { isHostedStaticApp } from "~/hostedPairing";
import { useEnvironments } from "~/state/environments";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const OPENER_STORAGE_KEY = "t3code:prompt-link-opener";
const Opener = Schema.NullOr(Schema.Literals(["app", "browser"]));

interface LinkSummary {
  readonly title: string;
  readonly description: string;
  readonly prompt: LinkedPrompt | null;
  readonly details: ReadonlyArray<string>;
}

function summarize(
  appPath: string,
  resolve: MessageResolver,
): { ok: true; value: LinkSummary } | { ok: false; error: string } {
  const PROMPT_HEADER = {
    title: resolve(msg("Open this prompt")),
    description: resolve(msg("It opens as a draft. Nothing runs until you press Send.")),
  };
  const url = new URL(appPath, window.location.origin);
  if (url.pathname !== "/new") {
    const prompt = parseThreadLinkPrompt(url.search, resolve);
    if (!prompt.ok) return prompt;
    return {
      ok: true,
      value:
        prompt.value === null
          ? {
              title: resolve(msg("Open this thread")),
              description: resolve(
                msg("It opens in T3 Code if you're connected to the machine it runs on."),
              ),
              prompt: null,
              details: [],
            }
          : {
              ...PROMPT_HEADER,
              prompt: prompt.value,
              details: [resolve(msg("Opens one of your threads."))],
            },
    };
  }
  const link = parseNewThreadLink(url.search, resolve);
  if (!link.ok) return link;
  if (link.value.kind === "pull-request") {
    const { owner, name, number } = link.value.pullRequest;
    return {
      ok: true,
      value: {
        ...PROMPT_HEADER,
        prompt: link.value.prompt,
        details: [
          resolve(msg("Pull request {pullRequest}", { pullRequest: `${owner}/${name}#${number}` })),
        ],
      },
    };
  }
  const { repository, provider, model } = link.value;
  return {
    ok: true,
    value: {
      ...PROMPT_HEADER,
      prompt: link.value.prompt,
      details: [
        repository
          ? resolve(
              msg("Repository {repository}", {
                repository: `${repository.owner}/${repository.name}`,
              }),
            )
          : resolve(msg("No project")),
        ...(provider
          ? [resolve(msg("Model {model}", { model: model ? `${provider} ${model}` : provider }))]
          : []),
      ],
    },
  };
}

export function useHostedPromptLinkLanding(enabled: boolean): ReactNode | null {
  const href = useLocation({ select: (location) => location.href });
  const { environments, isReady } = useEnvironments();
  const [opener, setOpener] = useLocalStorage(OPENER_STORAGE_KEY, null, Opener);
  const [continuedHref, setContinuedHref] = useState<string | null>(null);
  const appPath =
    enabled && isHostedStaticApp()
      ? promptLinkAppPath(new URL(href, window.location.origin).href, window.location.origin)
      : null;
  if (appPath === null || continuedHref === href) return null;
  const canContinue = isReady && environments.length > 0;
  if (opener === "browser") {
    if (canContinue) return null;
    if (!isReady) return <></>;
  }
  return (
    <HostedPromptLinkLanding
      appPath={appPath}
      canContinue={canContinue}
      openInAppRemembered={opener === "app"}
      onChoose={(choice, remember) => {
        if (remember) setOpener(choice);
        if (choice === "browser") setContinuedHref(href);
      }}
    />
  );
}

function HostedPromptLinkLanding({
  appPath,
  canContinue,
  openInAppRemembered,
  onChoose,
}: {
  readonly appPath: string;
  readonly canContinue: boolean;
  readonly openInAppRemembered: boolean;
  readonly onChoose: (choice: "app" | "browser", remember: boolean) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const summary = summarize(appPath, m);
  const [remember, setRemember] = useState(false);
  const deepLink = promptLinkDeepLink(appPath);
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  const autoOpenedRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- redirects window.location to the app deep link once when the user chose to always open in the app
  useEffect(() => {
    if (!openInAppRemembered || !summary.ok || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    window.location.href = deepLink;
  }, [deepLink, openInAppRemembered, summary.ok]);

  if (!summary.ok) {
    return (
      <StandalonePage>
        <StandalonePageHeader title={gt("Could not open the link")} description={summary.error} />
      </StandalonePage>
    );
  }

  const { title, description, prompt, details } = summary.value;
  return (
    <StandalonePage>
      <StandalonePageHeader title={title} description={description} />
      {prompt !== null && prompt.hiddenCharacters > 0 ? (
        <Alert className="mt-5" variant="error">
          <AlertTitle>
            <T>This prompt had hidden characters, it may be malicious</T>
          </AlertTitle>
          <AlertDescription>
            {gt(
              "{count, plural, one {T3 Code removed {count} hidden character. Read the prompt before you send it.} other {T3 Code removed {count} hidden characters. Read the prompt before you send it.}}",
              { count: prompt.hiddenCharacters },
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {prompt !== null ? (
        <pre className="mt-5 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 text-sm whitespace-pre-wrap">
          {prompt.text}
        </pre>
      ) : null}
      {details.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{details.join(" · ")}</p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button render={<a href={deepLink} />} onClick={() => onChoose("app", remember)}>
          {onPhone ? gt("Open in app") : gt("Open in desktop app")}
        </Button>
        {canContinue ? (
          <Button variant="outline" onClick={() => onChoose("browser", remember)}>
            <T>Continue here</T>
          </Button>
        ) : null}
        <Button variant="ghost" render={<a href={DESKTOP_DOWNLOAD_URL} />}>
          <T>Get T3 Code</T>
        </Button>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        <T>Remember my choice</T>
      </label>
    </StandalonePage>
  );
}
