import {
  VAULT_SERVICE_LABELS,
  VAULT_SERVICE_MAX_ITEMS,
  type VaultCredentialService,
} from "@t3tools/contracts";
import { vaultServiceReadLabel } from "@t3tools/client-runtime/secret-request";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT, useMessages } from "gt-react";
import {
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  KeyRoundIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useState, type ElementType } from "react";
import { sourceControlIcon } from "~/sourceControlPresentation";
import {
  AirtableMark,
  AsanaMark,
  GmailMark,
  LinearMark,
  NetlifyMark,
  NotionMark,
  SlackMark,
  TodoistMark,
  TypeformMark,
  VercelMark,
} from "./VaultServiceMarks";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";

export type GenericCredentialKind = "token" | "login" | "note";
type CredentialChoice = VaultCredentialService | GenericCredentialKind;

export function credentialIcon(type: CredentialChoice): ElementType<{ className?: string }> {
  switch (type) {
    case "github":
    case "gitlab":
      return sourceControlIcon(sourceControlClients.get(type));
    case "slack":
      return SlackMark;
    case "gmail":
      return GmailMark;
    case "airtable":
      return AirtableMark;
    case "asana":
      return AsanaMark;
    case "linear":
      return LinearMark;
    case "netlify":
      return NetlifyMark;
    case "notion":
      return NotionMark;
    case "todoist":
      return TodoistMark;
    case "typeform":
      return TypeformMark;
    case "vercel":
      return VercelMark;
    case "login":
      return GlobeIcon;
    case "note":
      return FileTextIcon;
    case "token":
      return KeyRoundIcon;
  }
}

export function VaultCredentialPicker({
  services,
  onSelect,
  onClose,
}: {
  readonly services: readonly VaultCredentialService[];
  readonly onSelect: (choice: CredentialChoice) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const genericLabels = {
    token: gt("API token"),
    login: gt("Website login"),
    note: gt("Secure note"),
  };
  const labels = { ...VAULT_SERVICE_LABELS, ...genericLabels };
  function detail(id: CredentialChoice) {
    switch (id) {
      case "gmail":
        return gt("Mailbox messages");
      case "github":
        return gt("Repositories");
      case "gitlab":
      case "todoist":
      case "vercel":
        return gt("Projects");
      case "slack":
        return gt("Public channels");
      case "airtable":
        return gt("Bases");
      case "asana":
        return gt("Workspaces");
      case "linear":
        return gt("Teams");
      case "netlify":
        return gt("Sites");
      case "notion":
        return gt("Shared pages");
      case "typeform":
        return gt("Forms");
      case "token":
        return gt("Store a token without connecting a service");
      case "login":
        return gt("Store a username and password for one website");
      case "note":
        return gt("Store private text");
    }
  }
  const groups = [
    { title: gt("Service connections"), kind: "services", choices: services },
    { title: gt("Saved fields"), kind: "fields", choices: ["token", "login", "note"] as const },
  ].map(({ title, kind, choices }) => ({
    title,
    kind,
    choices: choices
      .map((id) => ({ id, label: labels[id], detail: detail(id) }))
      .filter((choice) => {
        const operation =
          choice.id === "gmail"
            ? gt("Read mailbox messages")
            : choice.id !== "token" && choice.id !== "login" && choice.id !== "note"
              ? vaultServiceReadLabel({ service: choice.id, limit: VAULT_SERVICE_MAX_ITEMS }, m)
              : "";
        return `${choice.label} ${choice.detail} ${operation}`.toLocaleLowerCase().includes(query);
      }),
  }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="h-[min(45rem,calc(100dvh-2rem))] max-w-[38rem] max-sm:h-[calc(100dvh-3rem)]">
        <DialogHeader>
          <DialogTitle>{gt("Add credential")}</DialogTitle>
          <DialogDescription>
            {gt("Connect a service or save a secret in your vault.")}
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 px-6 pb-4">
          <InputGroup size="lg">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              size="lg"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={gt("Search credentials")}
              placeholder={gt("Search services and credentials…")}
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={gt("Clear search")}
                  onClick={(event) => {
                    setSearch("");
                    event.currentTarget
                      .closest("[data-slot=input-group]")
                      ?.querySelector("input")
                      ?.focus();
                  }}
                >
                  <XIcon aria-hidden />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <DialogPanel scrollFade={false}>
          <div className="space-y-5">
            {groups.map(
              ({ title, kind, choices }) =>
                choices.length > 0 && (
                  <section
                    key={kind}
                    aria-label={title}
                    className={kind === "fields" ? "border-t border-border/60 pt-5" : undefined}
                  >
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
                    <div
                      className={
                        kind === "services"
                          ? "grid gap-x-4 gap-y-1 sm:grid-cols-2"
                          : "grid gap-2 sm:grid-cols-3"
                      }
                    >
                      {choices.map(({ id, label, detail }) => {
                        const Icon = credentialIcon(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            aria-label={label}
                            className={
                              kind === "services"
                                ? "group flex min-h-16 min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                                : "group flex min-h-12 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 px-3 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            }
                            onClick={() => onSelect(id)}
                          >
                            {kind === "services" ? (
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground">
                                <Icon aria-hidden className="size-6" />
                              </span>
                            ) : (
                              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium leading-5">{label}</span>
                              {kind === "services" && (
                                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                                  {detail}
                                </span>
                              )}
                            </span>
                            {kind === "services" && (
                              <ChevronRightIcon
                                aria-hidden
                                className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground group-focus-visible:text-foreground"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ),
            )}
            {groups.every(({ choices }) => !choices.length) && (
              <p role="status" className="py-12 text-center text-sm text-muted-foreground">
                {gt("No matching credentials. Try another name.")}
              </p>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
