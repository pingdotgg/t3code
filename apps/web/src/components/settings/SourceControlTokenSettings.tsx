import {
  isSecretReference,
  type EnvironmentId,
  type SecretReference,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
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
import { Label } from "../ui/label";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const hasToken = (token: SettingsSecretValue | undefined) =>
  typeof token === "string" ? token.length > 0 : token !== undefined;

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
  const gt = useGT();
  const isAzureDevOps = definition.kind === "azure-devops";
  const tokenAccess =
    definition.kind === "github"
      ? gt("read and write access to pull requests and contents")
      : isAzureDevOps
        ? gt("the Code (Read & write) scope in that organization")
        : credentials.tokenAccess;
  const savedTokenUse = isAzureDevOps
    ? gt("each organization signs in with its own token, in az and in direct reads")
    : credentials.savedTokenUse;
  const { tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${definition.label} token`,
  });
  const defaultHost = definition.publicHost ?? "";
  const [host, setHost] = useState(defaultHost);
  const secretSources = useSecretSources(environmentId);
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly draft: string | SecretReference;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const typedHost = host.trim();
  // A forge keyed by something narrower than a host names the key itself; "" when it names none.
  const normalizedHost =
    typedHost === ""
      ? ""
      : credentials.tokenKey === undefined
        ? typedHost.toLowerCase()
        : (credentials.tokenKey.normalize(typedHost) ?? "");
  const unrecognized = typedHost !== "" && normalizedHost === "";
  const savedToken = tokens[normalizedHost];
  const isSaved = hasToken(savedToken);
  const savedHosts = Object.entries(tokens)
    .filter(([, value]) => hasToken(value))
    .map(([saved]) => saved);
  const sourceKey = JSON.stringify([normalizedHost, savedToken ?? ""]);
  const draft =
    pending?.key === sourceKey ? pending.draft : isSecretReference(savedToken) ? savedToken : "";
  const submission = typeof draft === "string" ? draft.trim() : draft;

  const save = async (target: string, token: SettingsSecretValue) => {
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
      setPending(null);
      onSaved();
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (normalizedHost && submission !== "") void save(normalizedHost, submission);
      }}
    >
      {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {savedTokenUse === undefined ? (
            <T>
              A token saved here is used before{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs">
                <Var>{credentials.tokenEnvVar}</Var>
              </code>{" "}
              and the{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs">
                <Var>{credentials.cliName}</Var>
              </code>{" "}
              login, so <Var>{definition.label}</Var> works without the{" "}
              <Var>{credentials.cliLabel}</Var>. Give it <Var>{tokenAccess}</Var>.
            </T>
          ) : (
            <T>
              A token saved here is used before{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs">
                <Var>{credentials.tokenEnvVar}</Var>
              </code>{" "}
              and the{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs">
                <Var>{credentials.cliName}</Var>
              </code>{" "}
              login, so <Var>{savedTokenUse}</Var>. Give it <Var>{tokenAccess}</Var>.
            </T>
          )}{" "}
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
              <T>Create a token</T>
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          ) : null}
        </p>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="grid gap-1.5">
            <Label htmlFor={`${definition.kind}-token-host-${environmentId}`}>
              {isAzureDevOps ? <T>Organization</T> : (credentials.tokenKey?.label ?? <T>Host</T>)}
            </Label>
            <Input
              id={`${definition.kind}-token-host-${environmentId}`}
              autoComplete="off"
              size="sm"
              placeholder={credentials.tokenKey?.placeholder ?? defaultHost}
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${definition.kind}-token-${environmentId}`}>
              <T>Token</T>
            </Label>
            <SecretSourceInput
              id={`${definition.kind}-token-${environmentId}`}
              size="sm"
              aria-label={gt("{host} token", { host: definition.label })}
              environmentId={environmentId}
              configured={isSaved && !isSecretReference(savedToken)}
              value={draft}
              sources={secretSources}
              onChange={(event) => setPending({ key: sourceKey, draft: event.target.value })}
              onSecretChange={(secret) => setPending({ key: sourceKey, draft: secret ?? "" })}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {unrecognized
              ? gt("Not recognized. Try {example}.", {
                  example: credentials.tokenKey?.placeholder ?? defaultHost,
                })
              : savedHosts.length === 0
                ? gt("No token saved; the server uses {envVar} or the {cliName} login.", {
                    envVar: credentials.tokenEnvVar,
                    cliName: credentials.cliName,
                  })
                : gt("Saved for {hosts}.", { hosts: savedHosts.join(", ") })}
          </p>
          <div className="flex shrink-0 gap-2">
            {isSaved ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void save(normalizedHost, "")}
              >
                <T>Remove</T>
              </Button>
            ) : null}
            <Button
              type="submit"
              size="xs"
              disabled={!normalizedHost || submission === "" || saving}
            >
              <T>Save</T>
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
