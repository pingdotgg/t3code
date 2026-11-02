import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useT } from "../../hooks/useI18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  readHostCredentialSettings,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
} from "@t3tools/client-runtime/source-control-clients";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { Label } from "../ui/label";

/** Placeholders swapped for inline markup after translation. */
const SLOT_ENV = "\u0001";
const SLOT_CLI = "\u0002";

export function SourceControlTokenSettings({
  environmentId,
  definition,
  credentials,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly credentials: SourceControlHostCredentials;
  readonly onSaved: () => void;
}) {
  const t = useT();
  const { tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} token`,
  });
  const defaultHost = definition.publicHost ?? "";
  const [host, setHost] = useState(defaultHost);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const normalizedHost = host.trim().toLowerCase();
  const isSaved = (tokens[normalizedHost] ?? "").length > 0;
  const savedHosts = Object.entries(tokens)
    .filter(([, value]) => value.length > 0)
    .map(([saved]) => saved);

  const save = async (target: string, token: string) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      // Send the whole map; other tokens' redaction markers preserve their values.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { tokens: { ...tokens, [target]: token } } },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft("");
      onSaved();
    }
  };

  const [introA, introB, introC] = t("settings.code.scToken.intro", {
    envVar: SLOT_ENV,
    cli: SLOT_CLI,
    label: definition.label,
    cliLabel: credentials.cliLabel,
    access: credentials.tokenAccess,
  }).split(/[\u0001\u0002]/);

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (normalizedHost && draft.trim()) void save(normalizedHost, draft.trim());
      }}
    >
      {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {introA}
          <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.tokenEnvVar}</code>
          {introB}
          <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.cliName}</code>
          {introC}{" "}
          {normalizedHost || defaultHost ? (
            <InlineButton
              render={
                <a
                  href={credentials.newTokenUrl(normalizedHost || defaultHost)}
                  target="_blank"
                  rel="noreferrer noopener"
                />
              }
            >
              {t("settings.code.scToken.createToken")}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          ) : null}
        </p>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="grid gap-1.5">
            <Label htmlFor={`${definition.kind}-token-host-${environmentId}`}>
              {t("settings.code.scToken.host")}
            </Label>
            <Input
              id={`${definition.kind}-token-host-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder={defaultHost}
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${definition.kind}-token-${environmentId}`}>
              {t("settings.code.scToken.token")}
            </Label>
            <SecretInput
              id={`${definition.kind}-token-${environmentId}`}
              size="sm"
              configured={isSaved}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {savedHosts.length === 0
              ? t("settings.code.scToken.noneSaved", {
                  envVar: credentials.tokenEnvVar,
                  cli: credentials.cliName,
                })
              : t("settings.code.scToken.savedFor", { hosts: savedHosts.join(", ") })}
          </p>
          <div className="flex shrink-0 gap-2">
            {isSaved ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void save(normalizedHost, "")}
              >
                {t("settings.code.scToken.remove")}
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!normalizedHost || !draft.trim() || saving}>
              {t("settings.code.scToken.save")}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
