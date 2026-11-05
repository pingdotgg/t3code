import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

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
          A token saved here is used before{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.tokenEnvVar}</code>{" "}
          and the{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.cliName}</code> login,
          so {definition.label} works without the {credentials.cliLabel}. Give it{" "}
          {credentials.tokenAccess}.{" "}
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
              Create a token
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          ) : null}
        </p>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="grid gap-1.5">
            <Label htmlFor={`${definition.kind}-token-host-${environmentId}`}>Host</Label>
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
            <Label htmlFor={`${definition.kind}-token-${environmentId}`}>Token</Label>
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
              ? `No token saved; the server uses ${credentials.tokenEnvVar} or the ${credentials.cliName} login.`
              : `Saved for ${savedHosts.join(", ")}.`}
          </p>
          <div className="flex shrink-0 gap-2">
            {isSaved ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void save(normalizedHost, "")}
              >
                Remove
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!normalizedHost || !draft.trim() || saving}>
              Save
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
