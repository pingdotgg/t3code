import {
  GmailClientId,
  type EnvironmentId,
  type LocalVaultEntry,
  type LocalVaultResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { useGT } from "gt-react";
import { GmailMark } from "./VaultServiceMarks";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Label } from "../ui/label";
import { VaultPinField } from "./VaultPinDialog";
import { canReachCallback, parseCallback, useSuggestedGmailRedirect } from "./GmailVaultRoute";
import { privateVaultRoute } from "./privateVaultRoute";

const validClientId = Schema.is(GmailClientId);

function googleCallback(value: string, clientId: string): URL | null {
  const url = URL.parse(value);
  if (
    !url ||
    !value.startsWith("https://accounts.google.com/o/oauth2/v2/auth?") ||
    value.includes("#") ||
    url.searchParams.has("client_secret") ||
    url.searchParams.getAll("client_id").length !== 1 ||
    url.searchParams.get("client_id") !== clientId
  ) {
    return null;
  }
  const redirects = url.searchParams.getAll("redirect_uri");
  return redirects.length === 1 ? parseCallback(redirects[0]) : null;
}

export function GmailVaultDialog({
  target,
  onClose,
  onConfigured,
  onConnected,
}: {
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly title?: string;
    readonly gmailClient?: LocalVaultEntry["gmailClient"];
    readonly gmailRedirectUri?: string | undefined;
    readonly edit?: boolean;
  };
  readonly onClose: () => void;
  readonly onConfigured: () => void;
  readonly onConnected: () => void;
}) {
  const gt = useGT();
  const form = useId();
  const command = useAtomCommand(serverEnvironment.manageLocalVault, {
    reportFailure: false,
    reportDefect: false,
  });
  const [title, setTitle] = useState(target.title ?? "");
  const [saved, setSaved] = useState(target.gmailClient);
  const [editClient, setEditing] = useState(!target.gmailClient || target.edit === true);
  const [clientId, setClientId] = useState(target.gmailClient?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const redirectUri = useSuggestedGmailRedirect(target.environmentId, target.gmailRedirectUri);
  const editing = editClient || (!!redirectUri && saved?.redirectUri !== redirectUri);
  const [authorization, setAuthorization] = useState<LocalVaultResult["gmailAuthorization"]>();
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretRequired = !saved || clientId.trim() !== saved.clientId;
  const pinValid = /^[0-9]{6,8}$/.test(pin);
  const canSubmit =
    !!title.trim() &&
    (editing
      ? !!redirectUri &&
        validClientId(clientId.trim()) &&
        (!secretRequired || !!clientSecret.trim()) &&
        pinValid
      : !!saved && !!redirectUri && (!authorization || pinValid));
  const unreachable = gt(
    "Google cannot return to this environment from this device. Configure a reachable HTTPS callback for this server, or finish setup on the server itself.",
  );
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Async vault and browser actions must stop updating the editor after its dialog unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openGoogle = async (auth: NonNullable<LocalVaultResult["gmailAuthorization"]>) => {
    setPending(true);
    setError(null);
    await (async () => {
      try {
        const callback = saved && googleCallback(auth.url, saved.clientId);
        if (
          !callback ||
          callback.href !== saved?.redirectUri ||
          callback.href !== redirectUri ||
          !(await canReachCallback(target.environmentId, callback))
        ) {
          if (!mounted.current) return;
          setAuthorization(undefined);
          setPin("");
          setError(
            callback
              ? unreachable
              : gt("The environment did not return a valid Google consent link."),
          );
          return;
        }
        if (!mounted.current || !privateVaultRoute(target.environmentId)) return;
        setAuthorization(auth);
        await ensureLocalApi().shell.openExternal(auth.url);
      } catch {
        if (mounted.current) setError(gt("Could not open Google. Restart sign-in to try again."));
      }
    })().finally(() => {
      if (mounted.current) setPending(false);
    });
  };
  const startGoogle = async () => {
    setAuthorization(undefined);
    setPin("");
    setError(null);
    if (!privateVaultRoute(target.environmentId)) {
      setError(unreachable);
      return;
    }
    setPending(true);
    await (async () => {
      try {
        const result = await command({
          environmentId: target.environmentId,
          input: { action: "gmail-start", name: target.name, title: target.title ?? title.trim() },
        });
        if (!mounted.current) return;
        if (result._tag !== "Success") {
          setError(gt("Could not reach the vault. Try again."));
          return;
        }
        if (result.value.error) {
          setError(result.value.error);
          return;
        }
        const auth = result.value.gmailAuthorization;
        if (!auth?.flowId) {
          setError(gt("The environment did not return a valid Google consent link."));
          return;
        }
        await openGoogle(auth);
      } catch {
        if (mounted.current) setError(gt("Could not reach the vault. Try again."));
      }
    })().finally(() => {
      if (mounted.current) setPending(false);
    });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !canSubmit) return;
    if (!privateVaultRoute(target.environmentId)) {
      setPin("");
      setClientSecret("");
      setError(
        gt(
          "Use HTTPS or the local host desktop before entering Google credentials or a vault PIN.",
        ),
      );
      return;
    }
    setPending(true);
    setError(null);
    await (async () => {
      try {
        if (editing && redirectUri) {
          const approval = Redacted.make(pin);
          const secret = clientSecret ? Redacted.make(clientSecret) : undefined;
          setPin("");
          setClientSecret("");
          await (async () => {
            const callback = parseCallback(redirectUri);
            if (
              !callback ||
              !(await canReachCallback(target.environmentId, callback)) ||
              !privateVaultRoute(target.environmentId)
            ) {
              if (mounted.current) setError(unreachable);
              return;
            }
            if (!mounted.current) return;
            const result = await command({
              environmentId: target.environmentId,
              input: {
                action: "gmail-configure",
                name: target.name,
                title: title.trim(),
                clientId: clientId.trim(),
                ...(secret ? { clientSecret: secret } : {}),
                redirectUri,
                pin: approval,
              },
            });
            if (!mounted.current) return;
            if (result._tag !== "Success" || result.value.error) {
              setError(
                gt(
                  "Could not save the Google client. Check the client details and vault PIN, then try again.",
                ),
              );
              return;
            }
            setSaved({ clientId: clientId.trim(), redirectUri });
            setAuthorization(undefined);
            setEditing(false);
            onConfigured();
          })().finally(() => {
            Redacted.wipeUnsafe(approval);
            if (secret) Redacted.wipeUnsafe(secret);
          });
        } else if (!authorization) {
          await startGoogle();
        } else {
          const approval = Redacted.make(pin);
          setPin("");
          const result = await command({
            environmentId: target.environmentId,
            input: {
              action: "gmail-finish",
              name: target.name,
              flowId: authorization.flowId,
              pin: approval,
            },
          }).finally(() => Redacted.wipeUnsafe(approval));
          if (!mounted.current) return;
          if (result._tag !== "Success") setError(gt("Could not reach the vault. Try again."));
          else if (result.value.error) setError(result.value.error);
          else onConnected();
        }
      } catch {
        if (mounted.current) setError(gt("Could not reach the vault. Try again."));
      }
    })().finally(() => {
      if (mounted.current) setPending(false);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <GmailMark className="size-6 shrink-0" aria-hidden />
              {gt("Credential connection")}
            </span>
          </DialogTitle>
          <DialogDescription>
            {authorization
              ? gt(
                  "Approve read-only access on Google, then return here and enter your vault PIN to finish.",
                )
              : editing
                ? gt(
                    "Save your Google OAuth client to this vault entry. You can connect a mailbox now or later.",
                  )
                : gt(
                    "Your Google client is saved. Continue to Google to authorize a mailbox for this entry.",
                  )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={form} autoComplete="off" className="grid gap-4" onSubmit={submit}>
            {!editing || target.title !== undefined || saved ? (
              <p className="text-sm break-all">
                {gt("Vault entry: {title}", { title: target.title ?? title.trim() })}
              </p>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor={`${form}-title`}>{gt("Name")}</Label>
                <Input
                  id={`${form}-title`}
                  autoFocus
                  value={title}
                  maxLength={120}
                  required
                  disabled={pending}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {gt("Use this name to mention the mailbox in chat.")}
                </p>
              </div>
            )}
            {editing ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${form}-callback`}>{gt("OAuth redirect URL")}</Label>
                  {redirectUri ? (
                    <div className="flex items-center gap-2">
                      <Input
                        id={`${form}-callback`}
                        readOnly
                        value={redirectUri}
                        onFocus={(event) => event.target.select()}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(redirectUri);
                            setCopied(true);
                          } catch {
                            setPin("");
                            setClientSecret("");
                            setError(gt("Select the redirect URL and copy it manually."));
                          }
                        }}
                      >
                        {copied ? gt("Copied") : gt("Copy URL")}
                      </Button>
                    </div>
                  ) : (
                    <p role="alert" className="text-sm text-destructive">
                      {unreachable}
                    </p>
                  )}
                  {saved && redirectUri && saved.redirectUri !== redirectUri ? (
                    <p className="text-xs text-muted-foreground">
                      {gt("Use current environment’s redirect URL")}
                    </p>
                  ) : null}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {gt(
                      "Enable the Gmail API in Google Cloud. Create a Web application OAuth client and add this exact URL under Authorized redirect URIs. This connection does not use Authorized JavaScript origins.",
                    )}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <a
                      className="underline underline-offset-2"
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {gt("Google Cloud credentials")}
                    </a>
                    <a
                      className="underline underline-offset-2"
                      href="https://developers.google.com/workspace/guides/create-credentials#web-application"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {gt("Google setup guide")}
                    </a>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${form}-client`}>{gt("Client ID")}</Label>
                  <Input
                    id={`${form}-client`}
                    required
                    spellCheck={false}
                    disabled={pending || !redirectUri}
                    placeholder="123-example.apps.googleusercontent.com"
                    aria-invalid={!!clientId.trim() && !validClientId(clientId.trim())}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${form}-secret`}>{gt("Client secret")}</Label>
                  <Input
                    id={`${form}-secret`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={pending || !redirectUri}
                    required={secretRequired}
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                  {saved ? (
                    <p className="text-xs text-muted-foreground">
                      {gt(
                        "Leave blank to keep the saved secret for the same client ID. Changing client details requires reconnecting the mailbox.",
                      )}
                    </p>
                  ) : null}
                </div>
                <VaultPinField value={pin} onChange={setPin} disabled={pending || !redirectUri} />
              </>
            ) : !authorization ? (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">{gt("Client ID")}</span>
                <span className="text-sm break-all">{saved?.clientId}</span>
                {!redirectUri ? (
                  <p role="alert" className="text-sm text-destructive">
                    {unreachable}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setEditing(true);
                  }}
                >
                  {gt("Edit client")}
                </Button>
              </div>
            ) : null}
            {!authorization ? (
              <div className="grid gap-1 border-t border-border/60 pt-3 text-xs">
                <p className="font-medium">{gt("Gmail access · read only")}</p>
                <code className="break-all">https://www.googleapis.com/auth/gmail.readonly</code>
                <p className="leading-relaxed text-muted-foreground">
                  {gt(
                    "Each read needs your approval. Credentials are used only with these Google services:",
                  )}
                </p>
                <code className="break-all">
                  accounts.google.com · oauth2.googleapis.com · gmail.googleapis.com
                </code>
              </div>
            ) : null}
            <details className="text-xs leading-relaxed">
              <summary className="w-fit cursor-pointer text-muted-foreground">
                {gt("Google account setup")}
              </summary>
              <div className="mt-2 grid gap-2 text-muted-foreground">
                <p>
                  {gt(
                    "For a new app used only by you, Google’s Personal mode connects the account that created it without test users. Existing External or Internal apps cannot switch to Personal mode.",
                  )}
                </p>
                <a
                  className="w-fit underline underline-offset-2"
                  href="https://console.cloud.google.com/auth/overview/personal"
                  target="_blank"
                  rel="noreferrer"
                >
                  {gt("Create a personal Google app")}
                </a>
                <p>
                  {gt(
                    "If your app is External and in Testing, add the Gmail address under Audience → Test users. Google expires these authorizations after seven days.",
                  )}
                </p>
                <a
                  className="w-fit underline underline-offset-2"
                  href="https://console.cloud.google.com/auth/audience"
                  target="_blank"
                  rel="noreferrer"
                >
                  {gt("Google audience settings")}
                </a>
              </div>
            </details>
            {authorization ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-self-start"
                  disabled={pending}
                  onClick={() => void startGoogle()}
                >
                  {gt("Restart Google sign-in")}
                </Button>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {gt(
                    "Restarting replaces the previous sign-in link. Complete only the newest Google sign-in window.",
                  )}
                </p>
                <VaultPinField value={pin} onChange={setPin} disabled={pending} />
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {saved && !editing && !authorization ? gt("Done") : gt("Cancel")}
          </Button>
          <Button type="submit" form={form} disabled={pending || !canSubmit}>
            {editing
              ? gt("Save client")
              : authorization
                ? pending
                  ? gt("Connecting…")
                  : gt("Finish connection")
                : pending
                  ? gt("Opening Google…")
                  : gt("Continue to Google")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
