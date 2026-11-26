// Fork: Kaluwa's Extensions page. What can be done to one extension in one subscription.
import type { ExtensionsMutation, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CopyIcon, LibraryIcon, LinkIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useExtensions } from "./extensionsContext";
import { type ExtensionEntry, copyMutation, presenceHealth } from "./extensionsModel";
import { EditButton } from "./extensionsParts";

function removeMutation(
  entry: ExtensionEntry,
  subscription: ExtensionsSubscription,
): ExtensionsMutation | null {
  const instanceId = subscription.instanceId;
  if (entry.kind === "mcp") return { _tag: "McpRemove", instanceId, name: entry.id };
  if (entry.kind === "plugin") return { _tag: "PluginUninstall", instanceId, pluginId: entry.id };
  return entry.presence.get(instanceId)?.skillSource === "library"
    ? { _tag: "SkillUnlink", instanceId, name: entry.id }
    : null;
}

/** Sign in, retry, on/off and remove for an extension the subscription has. */
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
  const { run, recheck, checking, isPending, canEdit } = useExtensions();
  const [confirming, setConfirming] = useState(false);
  const [action, setAction] = useState<"signIn" | "remove" | "move" | null>(null);
  const presence = entry.presence.get(subscription.instanceId);
  if (presence === undefined || presence.managedElsewhere) return null;

  const instanceId = subscription.instanceId;
  const busy = isPending(instanceId, entry.key);
  const health = presenceHealth(presence);
  const remove = removeMutation(entry, subscription);
  const act = async (name: typeof action, mutation: ExtensionsMutation) => {
    setAction(name);
    await run([mutation]);
    setAction(null);
  };

  if (confirming && remove !== null) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="text-xs text-muted-foreground">
          {entry.kind === "plugin"
            ? gt("Uninstall from {subscription}?", { subscription: subscription.displayName })
            : entry.kind === "skill"
              ? gt("Unlink from {subscription}?", { subscription: subscription.displayName })
              : gt("Remove from {subscription}?", { subscription: subscription.displayName })}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
          <T>Cancel</T>
        </Button>
        <EditButton
          size="xs"
          variant="destructive-outline"
          busy={action === "remove"}
          onClick={() => {
            setConfirming(false);
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

  const removeLabel =
    entry.kind === "plugin"
      ? gt("Uninstall {name}", { name: entry.name })
      : entry.kind === "skill"
        ? gt("Unlink {name}", { name: entry.name })
        : gt("Remove {name}", { name: entry.name });

  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {entry.kind === "mcp" && health === "needsAuth" && subscription.capabilities.mcpSignIn ? (
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
          {checking ? gt("Checking…") : gt("Retry")}
        </Button>
      ) : null}
      {!fixOnly && entry.kind === "skill" && presence.skillSource === "local" ? (
        <EditButton
          size="xs"
          variant="outline"
          busy={action === "move"}
          busyLabel={gt("Moving…")}
          disabled={busy}
          onClick={() =>
            void act("move", { _tag: "SkillMoveToLibrary", instanceId, name: entry.id })
          }
        >
          <LibraryIcon />
          <T>Move to library</T>
        </EditButton>
      ) : null}
      {!fixOnly &&
      (entry.kind === "plugin" ||
        (entry.kind === "mcp" && subscription.capabilities.mcpSetEnabled)) ? (
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
            void run([
              entry.kind === "mcp"
                ? { _tag: "McpSetEnabled", instanceId, name: entry.id, enabled }
                : { _tag: "PluginSetEnabled", instanceId, pluginId: entry.id, enabled },
            ])
          }
        />
      ) : null}
      {!fixOnly && remove !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={removeLabel}
                disabled={busy || !canEdit}
                onClick={() => setConfirming(true)}
              />
            }
          >
            <Trash2Icon />
          </TooltipTrigger>
          <TooltipPopup>{removeLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
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
      busyLabel={gt("Adding…")}
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
