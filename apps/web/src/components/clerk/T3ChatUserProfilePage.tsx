import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T3CHAT_PLAN_TUNNEL_LIMITS, type RelayT3ChatLink } from "@t3tools/contracts/relay";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import {
  createManagedRelayT3ChatLinkRequestCommand,
  unlinkManagedRelayT3ChatCommand,
  useManagedRelayT3ChatLink,
} from "../../cloud/managedRelayState";
import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";

function planLabel(link: RelayT3ChatLink): string {
  switch (link.plan) {
    case "premier":
      return `Premier · up to ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} tunnels`;
    case "pro":
      return `Pro · up to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} tunnels, or ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} with Premier`;
    case "free":
      return "Upgrade on T3 Chat for more tunnels";
  }
}

function reportFailure(title: string, cause: unknown) {
  const traceId = findErrorTraceId(cause);
  toastManager.add({
    type: "error",
    title,
    description: cause instanceof Error ? cause.message : "Try again.",
    data: traceId
      ? {
          secondaryActionProps: {
            children: "Copy trace ID",
            onClick: () => void navigator.clipboard?.writeText(traceId),
          },
        }
      : undefined,
  });
}

/** Links a T3 Chat account so paid subscribers get more tunnels. */
export function T3ChatUserProfilePage() {
  const linkState = useManagedRelayT3ChatLink();
  const createLinkRequest = useAtomCommand(createManagedRelayT3ChatLinkRequestCommand, {
    reportFailure: false,
  });
  const unlink = useAtomCommand(unlinkManagedRelayT3ChatCommand, { reportFailure: false });
  const [pending, setPending] = useState<"link" | "unlink" | null>(null);
  // Kept so a blocked popup still leaves the user a link to open.
  const [linkUrl, setLinkUrl] = useState<string | null>(null);

  const handleLink = async () => {
    const accountId = linkState.accountId;
    if (!accountId || pending) return;
    setPending("link");
    const result = await createLinkRequest({ accountId });
    if (result._tag === "Success") {
      setLinkUrl(result.value);
      await readLocalApi()
        ?.shell.openExternal(result.value)
        .catch(() => undefined);
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not start linking", squashAtomCommandFailure(result));
    }
    setPending(null);
  };

  const handleUnlink = async () => {
    const accountId = linkState.accountId;
    if (!accountId || pending) return;
    setPending("unlink");
    const result = await unlink({ accountId });
    if (result._tag === "Success") {
      setLinkUrl(null);
      linkState.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not unlink T3 Chat", squashAtomCommandFailure(result));
    }
    setPending(null);
  };

  const data = linkState.data;
  const link = data?.link ?? null;

  return (
    <ClerkUserProfilePage
      title="T3 Chat"
      description={`Link a paid T3 Chat account for more T3 Connect tunnels: up to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} with Pro, ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} with Premier.`}
      action={
        <ClerkUserProfileRefreshButton
          disabled={pending !== null}
          isPending={linkState.isPending}
          onClick={linkState.refresh}
        />
      }
    >
      {linkState.error ? (
        <div className="border-t py-3 text-xs" role="alert">
          <p className="font-medium text-destructive-foreground">Could not load T3 Chat link</p>
          <p className="mt-0.5 text-muted-foreground">{linkState.error}</p>
        </div>
      ) : data === null ? null : !data.available ? (
        <p className="border-t py-4 text-xs text-muted-foreground">
          This T3 Connect server does not support T3 Chat linking.
        </p>
      ) : (
        <ul className="border-t">
          <ClerkUserProfileRow icon={<MessageSquareIcon className="size-4" />}>
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm leading-4.5 font-medium text-foreground">
                  {link ? link.email : "Not linked"}
                </h3>
                <p className="mt-1 text-xs leading-4.5 text-muted-foreground">
                  {link ? (
                    planLabel(link)
                  ) : linkUrl ? (
                    <>
                      Confirm on{" "}
                      <a
                        className="underline"
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        t3.chat
                      </a>
                      , then select Refresh.
                    </>
                  ) : (
                    "You confirm the link on t3.chat."
                  )}
                </p>
              </div>
              {link ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={pending !== null}
                  onClick={() => void handleUnlink()}
                >
                  {pending === "unlink" ? "Unlinking…" : "Unlink"}
                </Button>
              ) : (
                <Button size="sm" disabled={pending !== null} onClick={() => void handleLink()}>
                  {pending === "link" ? "Opening…" : "Link T3 Chat"}
                </Button>
              )}
            </div>
          </ClerkUserProfileRow>
        </ul>
      )}
    </ClerkUserProfilePage>
  );
}
