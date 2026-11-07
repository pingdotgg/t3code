import { T3CHAT_PLAN_TUNNEL_LIMITS, type RelayT3ChatLink } from "@t3tools/contracts/relay";
import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useManagedTunnelUsage } from "../../cloud/managedRelayState";
import { T3CHAT_SUBSCRIPTION_URL, TunnelUsageMeter } from "../cloud/TunnelUsage";
import { Button } from "../ui/button";
import {
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";
import { useT3ChatLink } from "./useT3ChatLink";
import { useT } from "../../hooks/useI18n";
import type { TranslateFn } from "@t3tools/client-runtime/i18n";

function planLabel(link: RelayT3ChatLink, t: TranslateFn): ReactNode {
  const upgradeLink = (
    <a
      className="underline"
      href={T3CHAT_SUBSCRIPTION_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t("misc.clerk.chat.upgradeLink")}
    </a>
  );
  switch (link.plan) {
    case "premier":
      return t("misc.clerk.chat.premier", { count: T3CHAT_PLAN_TUNNEL_LIMITS.premier });
    case "pro":
      return (
        <>
          {t("misc.clerk.chat.proBefore", { count: T3CHAT_PLAN_TUNNEL_LIMITS.pro })}
          {upgradeLink}
          {t("misc.clerk.chat.proAfter", { count: T3CHAT_PLAN_TUNNEL_LIMITS.premier })}
        </>
      );
    case "free":
      return (
        <>
          {upgradeLink}
          {t("misc.clerk.chat.freeAfter")}
        </>
      );
  }
}

/** Links a T3 Chat account so paid subscribers get more tunnels. */
export function T3ChatUserProfilePage() {
  const t = useT();
  const { linkState, pending, linkUrl, link: handleLink, unlink: handleUnlink } = useT3ChatLink();
  const usage = useManagedTunnelUsage();

  const data = linkState.data;
  const link = data?.link ?? null;

  return (
    <ClerkUserProfilePage
      title="T3 Chat"
      description={t("misc.clerk.chat.description", {
        pro: T3CHAT_PLAN_TUNNEL_LIMITS.pro,
        premier: T3CHAT_PLAN_TUNNEL_LIMITS.premier,
      })}
      action={
        <ClerkUserProfileRefreshButton
          disabled={pending !== null}
          isPending={linkState.isPending}
          onClick={usage.refresh}
        />
      }
    >
      {linkState.error ? (
        <div className="border-t py-3 text-xs" role="alert">
          <p className="font-medium text-destructive-foreground">
            {t("misc.clerk.chat.loadFailed")}
          </p>
          <p className="mt-0.5 text-muted-foreground">{linkState.error}</p>
        </div>
      ) : data === null ? null : !data.available ? (
        <p className="border-t py-4 text-xs text-muted-foreground">
          {t("misc.clerk.chat.unsupported")}
        </p>
      ) : (
        <ul className="border-t">
          <ClerkUserProfileRow icon={<MessageSquareIcon className="size-4" />}>
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm leading-4.5 font-medium text-foreground">
                  {link ? link.email : t("misc.clerk.chat.notLinked")}
                </h3>
                <p className="mt-1 text-xs leading-4.5 text-muted-foreground">
                  {link ? (
                    planLabel(link, t)
                  ) : linkUrl ? (
                    <>
                      {t("misc.clerk.chat.confirmBefore")}
                      <a
                        className="underline"
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        t3.chat
                      </a>
                      {t("misc.clerk.chat.confirmAfter")}
                    </>
                  ) : (
                    t("misc.clerk.chat.confirmOnSite")
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
                  {pending === "unlink"
                    ? t("misc.clerk.chat.unlinking")
                    : t("misc.clerk.chat.unlink")}
                </Button>
              ) : (
                <Button size="sm" disabled={pending !== null} onClick={() => void handleLink()}>
                  {pending === "link" ? t("misc.clerk.chat.opening") : t("misc.clerk.chat.link")}
                </Button>
              )}
            </div>
          </ClerkUserProfileRow>
          {usage.used !== null && usage.limit !== null ? (
            <li className="border-t py-4">
              <TunnelUsageMeter used={usage.used} limit={usage.limit} />
            </li>
          ) : null}
        </ul>
      )}
    </ClerkUserProfilePage>
  );
}
