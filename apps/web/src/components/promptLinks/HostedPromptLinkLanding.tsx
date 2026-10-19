import {
  type LinkedPrompt,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
} from "@t3tools/shared/promptLinks";
import { useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { isHostedStaticApp } from "~/hostedPairing";
import { useEnvironments } from "~/state/environments";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const OPENER_STORAGE_KEY = "t3code:prompt-link-opener";
const Opener = Schema.NullOr(Schema.Literals(["app", "browser"]));
const DOWNLOAD_URL = "https://t3.codes/download";

interface LinkSummary {
  readonly prompt: LinkedPrompt | null;
  readonly details: ReadonlyArray<string>;
}

function summarize(
  appPath: string,
): { ok: true; value: LinkSummary } | { ok: false; error: string } {
  const url = new URL(appPath, window.location.origin);
  if (url.pathname !== "/new") {
    const prompt = parseThreadLinkPrompt(url.search);
    return prompt.ok
      ? { ok: true, value: { prompt: prompt.value, details: ["Opens one of your threads."] } }
      : prompt;
  }
  const link = parseNewThreadLink(url.search);
  if (!link.ok) return link;
  if (link.value.kind === "pull-request") {
    const { owner, name, number } = link.value.pullRequest;
    return {
      ok: true,
      value: { prompt: link.value.prompt, details: [`Pull request ${owner}/${name}#${number}`] },
    };
  }
  const { repository, provider, model } = link.value;
  return {
    ok: true,
    value: {
      prompt: link.value.prompt,
      details: [
        repository ? `Repository ${repository.owner}/${repository.name}` : "No project",
        ...(provider ? [`Model ${model ? `${provider} ${model}` : provider}`] : []),
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
  const summary = summarize(appPath);
  const [remember, setRemember] = useState(false);
  const deepLink = promptLinkDeepLink(appPath);
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (!openInAppRemembered || !summary.ok || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    window.location.href = deepLink;
  }, [deepLink, openInAppRemembered, summary.ok]);

  if (!summary.ok) {
    return (
      <StandalonePage tone="error">
        <StandalonePageHeader
          eyebrow={APP_DISPLAY_NAME}
          title="Could not open the link"
          description={summary.error}
        />
      </StandalonePage>
    );
  }

  const { prompt, details } = summary.value;
  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Open this prompt"
        description="It opens as a draft. Nothing runs until you press Send."
      />
      {prompt !== null && prompt.hiddenCharacters > 0 ? (
        <Alert className="mt-5" variant="error">
          <AlertTitle>This prompt had hidden characters, it may be malicious</AlertTitle>
          <AlertDescription>
            T3 Code removed {prompt.hiddenCharacters} hidden character
            {prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.
          </AlertDescription>
        </Alert>
      ) : null}
      {prompt !== null ? (
        <pre className="mt-5 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 text-sm whitespace-pre-wrap">
          {prompt.text}
        </pre>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">{details.join(" · ")}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button render={<a href={deepLink} />} onClick={() => onChoose("app", remember)}>
          {onPhone ? "Open in app" : "Open in desktop app"}
        </Button>
        {canContinue ? (
          <Button variant="outline" onClick={() => onChoose("browser", remember)}>
            Continue here
          </Button>
        ) : null}
        <Button variant="ghost" render={<a href={DOWNLOAD_URL} />}>
          Get T3 Code
        </Button>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        Remember my choice
      </label>
    </StandalonePage>
  );
}
