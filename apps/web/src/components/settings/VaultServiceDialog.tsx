import {
  VAULT_SERVICE_LABELS,
  type EnvironmentId,
  type VaultTokenService,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { msg, useGT, useMessages } from "gt-react";
import { useId, useState, type FormEvent } from "react";
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
import { privateVaultRoute } from "./privateVaultRoute";
import { credentialIcon } from "./VaultCredentialPicker";
import { VaultPinField } from "./VaultPinDialog";

const setup = {
  github: {
    url: "https://github.com/settings/personal-access-tokens/new",
    help: msg(
      "Use a fine-grained GitHub.com token with read access to repository metadata. Select only the repositories you want to list.",
    ),
  },
  gitlab: {
    url: "https://gitlab.com/-/user_settings/personal_access_tokens",
    help: msg(
      "Use a GitLab.com access token with the read_api scope to list projects you belong to.",
    ),
  },
  slack: {
    url: "https://api.slack.com/apps",
    help: msg(
      "Use a Slack bot token with the channels:read scope to list public channels in its workspace.",
    ),
  },
  airtable: {
    url: "https://airtable.com/create/tokens",
    help: msg(
      "Use an Airtable personal access token with schema.bases:read for the bases you select.",
    ),
  },
  asana: {
    url: "https://app.asana.com/0/my-apps",
    help: msg(
      "Use an Asana personal access token. It inherits your account permissions; use an account limited to the workspaces you need.",
    ),
  },
  linear: {
    url: "https://linear.app/settings/api",
    help: msg("Use a Linear personal API key with Read permission for the teams you want to list."),
  },
  netlify: {
    url: "https://app.netlify.com/user/applications#personal-access-tokens",
    help: msg(
      "Use a Netlify personal access token with a short expiry. It can do more than list sites; limit the issuing account’s access.",
    ),
  },
  notion: {
    url: "https://www.notion.so/profile/integrations",
    help: msg(
      "Use a Notion internal integration secret with Read content. Share only the pages you want to list with that integration.",
    ),
  },
  todoist: {
    url: "https://app.todoist.com/app/settings/integrations/developer",
    help: msg(
      "Use a Todoist personal API token. It can do more than list projects; use an account with only the projects you need.",
    ),
  },
  typeform: {
    url: "https://admin.typeform.com/account#/section/tokens",
    help: msg(
      "Use a Typeform personal access token with accounts:read and forms:read. Only accounts using api.typeform.com are supported.",
    ),
  },
  vercel: {
    url: "https://vercel.com/account/tokens",
    help: msg(
      "Use a Vercel access token with read access to the projects you need. An AI Gateway key cannot list projects.",
    ),
  },
} satisfies Record<VaultTokenService, { url: string; help: string }>;

const serviceIcons = {
  github: credentialIcon("github"),
  gitlab: credentialIcon("gitlab"),
  slack: credentialIcon("slack"),
  airtable: credentialIcon("airtable"),
  asana: credentialIcon("asana"),
  linear: credentialIcon("linear"),
  netlify: credentialIcon("netlify"),
  notion: credentialIcon("notion"),
  todoist: credentialIcon("todoist"),
  typeform: credentialIcon("typeform"),
  vercel: credentialIcon("vercel"),
};

export function VaultServiceDialog({
  environmentId,
  name,
  service,
  initialTitle,
  account,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly service: VaultTokenService;
  readonly initialTitle: string;
  readonly account?: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const form = useId();
  const [title, setTitle] = useState(initialTitle);
  const [token, setToken] = useState("");
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const command = useAtomCommand(serverEnvironment.manageLocalVault, {
    reportFailure: false,
    reportDefect: false,
  });
  const label = VAULT_SERVICE_LABELS[service];
  const Icon = serviceIcons[service];
  const canSubmit = !!title.trim() && !!token.trim() && /^\d{6,8}$/u.test(pin) && !pending;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPin("");
    setToken("");
    if (!privateVaultRoute(environmentId)) {
      setFailed(true);
      return;
    }
    setPending(true);
    setFailed(false);
    const secret = Redacted.make(token.trim());
    const approval = Redacted.make(pin);
    await (async () => {
      try {
        const result = await command({
          environmentId,
          input: {
            action: "connect-service",
            name,
            title: title.trim(),
            service,
            token: secret,
            pin: approval,
          },
        });
        if (result._tag !== "Success" || result.value.error) setFailed(true);
        else onSaved();
      } catch {
        setFailed(true);
      }
    })().finally(() => {
      Redacted.wipeUnsafe(secret);
      Redacted.wipeUnsafe(approval);
      setPending(false);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Icon aria-hidden className="size-5" />
              {gt("{service} credential", { service: label })}
            </span>
          </DialogTitle>
          <DialogDescription>{m(setup[service].help)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={form} autoComplete="off" className="grid gap-4" onSubmit={submit}>
            <a
              className="w-fit text-sm underline underline-offset-2"
              href={setup[service].url}
              target="_blank"
              rel="noreferrer"
            >
              {gt("Credential settings at {service}", { service: label })}
            </a>
            {account && (
              <p className="text-sm break-all">{gt("Connection: {account}", { account })}</p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor={`${form}-title`}>{gt("Name")}</Label>
              <Input
                id={`${form}-title`}
                autoFocus
                value={title}
                required
                maxLength={120}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${form}-token`}>
                {service === "slack" ? gt("Bot token") : gt("Access token")}
              </Label>
              <Input
                id={`${form}-token`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={token}
                required
                maxLength={6000}
                disabled={pending}
                onChange={(event) => setToken(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {account
                  ? gt(
                      "Enter a replacement token. The current connection stays in place until verification succeeds.",
                    )
                  : gt(
                      "Hyakki verifies the token with this service before saving it. Each read requires your PIN.",
                    )}
              </p>
            </div>
            <VaultPinField value={pin} onChange={setPin} disabled={pending} />
            {failed && (
              <p role="alert" className="text-sm text-destructive">
                {gt(
                  "Credential not saved. Check the token, its read permissions, and your vault PIN, then try again.",
                )}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button form={form} type="submit" disabled={!canSubmit}>
            {pending ? gt("Verifying…") : gt("Verify and save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
