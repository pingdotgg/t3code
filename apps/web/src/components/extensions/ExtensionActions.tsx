// Fork: Kaluwa's Extensions page. What can be done to one extension in one subscription.
import type { ExtensionsMutation, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  LibraryIcon,
  LinkIcon,
  PlusIcon,
  WrenchIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useExtensions } from "./extensionsContext";
import {
  CLAUDE_CONNECTORS_URL,
  type ExtensionFixProblem,
  entryFixProblem,
} from "./extensionsFixPrompt";
import {
  type ExtensionEntry,
  copyMutation,
  needsAttention,
  presenceHealth,
  supportsKind,
} from "./extensionsModel";
import { EditButton } from "./extensionsParts";

function removeMutation(
  entry: ExtensionEntry,
  subscription: ExtensionsSubscription,
): ExtensionsMutation | null {
  const instanceId = subscription.instanceId;
  const presence = entry.presence.get(instanceId);
  if (presence === undefined || presence.managedElsewhere) return null;
  if (!supportsKind(subscription, entry.kind)) return null;
  if (entry.kind === "mcp") return { _tag: "McpRemove", instanceId, name: entry.id };
  if (entry.kind === "plugin") return { _tag: "PluginUninstall", instanceId, pluginId: entry.id };
  return presence.skillSource === "library"
    ? { _tag: "SkillUnlink", instanceId, name: entry.id }
    : null;
}

export function FixWithAiButton({
  problem,
  subscription,
}: {
  readonly problem: ExtensionFixProblem;
  readonly subscription: ExtensionsSubscription;
}) {
  const gt = useGT();
  const { fixWithAi } = useExtensions();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="xs" variant="outline" onClick={() => fixWithAi(problem, subscription)} />
        }
      >
        <WrenchIcon />
        <T>Fix with AI</T>
      </TooltipTrigger>
      <TooltipPopup>
        {gt("Starts a new thread with step-by-step instructions for an agent to fix this.")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Stands where the remove button would be, and says why there is none. */
function WhyNoRemove({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<Button size="icon-xs" variant="ghost-muted" aria-label={label} />}
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md" padding="compact">
        <div className="flex flex-col gap-2 text-xs">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}

function NoRemoveReason({
  entry,
  subscription,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
}) {
  const gt = useGT();
  const { list } = useExtensions();
  const presence = entry.presence.get(subscription.instanceId);
  if (presence === undefined) return null;
  const label = gt("Why {name} can't be removed here", { name: entry.name });
  if (presence.managedElsewhere) {
    return (
      <WhyNoRemove label={label}>
        <p>
          <T>
            Connected through your claude.ai account. Add or remove it in claude.ai → Settings →
            Connectors.
          </T>
        </p>
        <p className="flex items-center gap-2">
          <span className="min-w-0 flex-1 font-mono wrap-anywhere select-all">
            {CLAUDE_CONNECTORS_URL}
          </span>
          <Button
            size="xs"
            variant="outline"
            render={<a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noreferrer noopener" />}
          >
            <ExternalLinkIcon />
            <T>Open</T>
          </Button>
        </p>
      </WhyNoRemove>
    );
  }
  if (!supportsKind(subscription, entry.kind)) {
    return (
      <WhyNoRemove label={label}>
        <p>
          {subscription.driver === "antigravity"
            ? gt("Shared by every Antigravity profile from {path}; Kaluwa only reads them.", {
                path: "~/.gemini",
              })
            : gt("{subscription} manages these itself; Kaluwa only reads them.", {
                subscription: subscription.displayName,
              })}
        </p>
      </WhyNoRemove>
    );
  }
  return (
    <WhyNoRemove label={label}>
      <p>
        {presence.libraryCopy === "none"
          ? gt(
              "This copy lives only in {subscription}, so Kaluwa won't delete it. Move it to the library ({path}) first: it becomes a link here that you can unlink, and other subscriptions can link the same copy.",
              { subscription: subscription.displayName, path: list.library.path },
            )
          : gt(
              "This copy lives only in {subscription}, so Kaluwa won't delete it. Use the library copy instead: this one is backed up and replaced with a link you can unlink.",
              { subscription: subscription.displayName },
            )}
      </p>
    </WhyNoRemove>
  );
}

type Action = "signIn" | "remove" | "library" | "toggle";

/** Sign in, retry, fix, on/off and remove for an extension the subscription has. */
export function ExtensionActions({
  entry,
  subscription,
  fixOnly = false,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
  /** Only what resolves a failure or a missing sign-in. */
  readonly fixOnly?: boolean;
}) {
  const gt = useGT();
  const { list, run, recheck, checking, isPending, canEdit } = useExtensions();
  const [confirming, setConfirming] = useState<"remove" | "library" | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const presence = entry.presence.get(subscription.instanceId);
  if (presence === undefined) return null;

  const instanceId = subscription.instanceId;
  const busy = isPending(instanceId, entry.key);
  const health = presenceHealth(presence);
  const remove = removeMutation(entry, subscription);
  const editable = !presence.managedElsewhere && supportsKind(subscription, entry.kind);
  const problem = needsAttention(health) ? entryFixProblem(entry, subscription) : null;
  const act = async (name: Action, mutation: ExtensionsMutation) => {
    setAction(name);
    await run([mutation]);
    setAction(null);
  };
  const localSkill = editable && entry.kind === "skill" && presence.skillSource === "local";
  const useLibrary: ExtensionsMutation = {
    _tag: "SkillUseLibraryCopy",
    instanceId,
    name: entry.id,
  };

  if (confirming === "remove" && remove !== null) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="text-xs text-muted-foreground">
          {entry.kind === "plugin"
            ? gt("Uninstall from {subscription}?", { subscription: subscription.displayName })
            : entry.kind === "skill"
              ? gt("Unlink from {subscription}?", { subscription: subscription.displayName })
              : gt("Remove from {subscription}?", { subscription: subscription.displayName })}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
          <T>Cancel</T>
        </Button>
        <EditButton
          size="xs"
          variant="destructive-outline"
          onClick={() => {
            setConfirming(null);
            void act("remove", remove);
          }}
        >
          {entry.kind === "plugin"
            ? gt("Uninstall")
            : entry.kind === "skill"
              ? gt("Unlink")
              : gt("Remove")}
        </EditButton>
      </span>
    );
  }
  if (confirming === "library") {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="max-w-64 text-end text-xs text-muted-foreground">
          <T>The library's version is different. This copy is backed up, then replaced.</T>
        </span>
        <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
          <T>Cancel</T>
        </Button>
        <EditButton
          size="xs"
          variant="warning-outline"
          onClick={() => {
            setConfirming(null);
            void act("library", useLibrary);
          }}
        >
          <T>Use library copy</T>
        </EditButton>
      </span>
    );
  }

  const removeLabel =
    entry.kind === "plugin"
      ? gt("Uninstall {name}", { name: entry.name })
      : entry.kind === "skill"
        ? gt("Unlink {name}", { name: entry.name })
        : gt("Remove {name}", { name: entry.name });

  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {editable &&
      entry.kind === "mcp" &&
      health === "needsAuth" &&
      subscription.capabilities.mcpSignIn ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <EditButton
                size="xs"
                variant="warning-outline"
                busy={action === "signIn"}
                busyLabel={gt("Waiting for browser…")}
                disabled={busy}
                onClick={() =>
                  void act("signIn", { _tag: "McpSignIn", instanceId, name: entry.id })
                }
              />
            }
          >
            <T>Sign in</T>
          </TooltipTrigger>
          <TooltipPopup>
            {gt("Opens the sign-in page in the browser on the machine running the server.")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {entry.kind === "mcp" && health === "failing" ? (
        <Button size="xs" variant="outline" disabled={checking} onClick={recheck}>
          {checking ? <Spinner /> : null}
          {checking ? gt("Checking…") : gt("Retry")}
        </Button>
      ) : null}
      {problem !== null ? <FixWithAiButton problem={problem} subscription={subscription} /> : null}
      {!fixOnly && localSkill ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <EditButton
                size="xs"
                variant={presence.libraryCopy === "different" ? "warning-outline" : "outline"}
                busy={action === "library"}
                busyLabel={presence.libraryCopy === "none" ? gt("Moving…") : gt("Linking…")}
                disabled={busy}
                onClick={() =>
                  presence.libraryCopy === "different"
                    ? setConfirming("library")
                    : void act(
                        "library",
                        presence.libraryCopy === "same"
                          ? useLibrary
                          : { _tag: "SkillMoveToLibrary", instanceId, name: entry.id },
                      )
                }
              />
            }
          >
            {presence.libraryCopy === "none" ? <LibraryIcon /> : <LinkIcon />}
            {presence.libraryCopy === "none" ? gt("Move to library") : gt("Use library copy")}
          </TooltipTrigger>
          <TooltipPopup>
            {presence.libraryCopy === "none"
              ? gt(
                  "Moves this skill into {path} so every subscription can link the same copy. {subscription} keeps using it through a link.",
                  { path: list.library.path, subscription: subscription.displayName },
                )
              : presence.libraryCopy === "same"
                ? gt(
                    "The library already has an identical copy. Replaces this one with a link to it, and keeps a backup.",
                  )
                : gt(
                    "The library has a different version of this skill. This copy is backed up and replaced with a link to the library's.",
                  )}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {!fixOnly &&
      editable &&
      (entry.kind === "plugin" ||
        (entry.kind === "mcp" && subscription.capabilities.mcpSetEnabled)) ? (
        action === "toggle" ? (
          <span className="flex w-7 justify-center">
            <Spinner size="sm" />
          </span>
        ) : (
          <Switch
            size="sm"
            checked={presence.enabled}
            disabled={busy || !canEdit}
            aria-label={
              presence.enabled
                ? gt("Turn off {name}", { name: entry.name })
                : gt("Turn on {name}", { name: entry.name })
            }
            onCheckedChange={(enabled) =>
              void act(
                "toggle",
                entry.kind === "mcp"
                  ? { _tag: "McpSetEnabled", instanceId, name: entry.id, enabled }
                  : { _tag: "PluginSetEnabled", instanceId, pluginId: entry.id, enabled },
              )
            }
          />
        )
      ) : null}
      {fixOnly ? null : remove === null ? (
        <NoRemoveReason entry={entry} subscription={subscription} />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={removeLabel}
                aria-busy={action === "remove"}
                disabled={busy || !canEdit}
                onClick={() => setConfirming("remove")}
              />
            }
          >
            {action === "remove" ? <Spinner /> : <Trash2Icon />}
          </TooltipTrigger>
          <TooltipPopup>{removeLabel}</TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}

/** Copy, install or link an extension the subscription lacks. */
export function ExtensionAddHereButton({
  entry,
  subscription,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
}) {
  const gt = useGT();
  const { run, isPending } = useExtensions();
  const mutation = copyMutation(entry, [subscription.instanceId]);
  if (mutation === null) return null;
  return (
    <EditButton
      size="xs"
      variant="outline"
      busy={isPending(subscription.instanceId, entry.key)}
      busyLabel={
        entry.kind === "skill"
          ? gt("Linking…")
          : entry.kind === "plugin"
            ? gt("Installing…")
            : gt("Copying…")
      }
      onClick={() => void run([mutation])}
    >
      {entry.kind === "skill" ? (
        <LinkIcon />
      ) : entry.kind === "plugin" ? (
        <PlusIcon />
      ) : (
        <CopyIcon />
      )}
      {entry.kind === "skill"
        ? gt("Link here")
        : entry.kind === "plugin"
          ? gt("Install here")
          : gt("Copy here")}
    </EditButton>
  );
}
