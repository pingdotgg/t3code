import { useAuth, useClerk } from "@clerk/react";
import { MessageSquareIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { msg, useMessages } from "gt-react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ChatUserProfilePage } from "./T3ChatUserProfilePage";
import { LatheConnectUserProfilePage } from "./LatheConnectUserProfilePage";

export const LATHE_CONNECT_ACCOUNT_PAGES = [
  {
    label: msg("Mobile clients"),
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "T3 Connect",
    url: "lathe-connect",
    icon: <ServerIcon className="size-4" />,
    content: <LatheConnectUserProfilePage />,
  },
  {
    label: "T3 Chat",
    url: "t3-chat",
    icon: <MessageSquareIcon className="size-4" />,
    content: <T3ChatUserProfilePage />,
  },
] as const;

export type LatheConnectAccountPageUrl = (typeof LATHE_CONNECT_ACCOUNT_PAGES)[number]["url"];

type PortalTargets = Readonly<Record<string, HTMLDivElement | undefined>>;

/** Keep portals rendered while the modal can open; Clerk owns the custom-page DOM nodes. */
export function useLatheConnectAccountPage(): {
  readonly open: ((page?: LatheConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const m = useMessages();
  const [targets, setTargets] = useState<PortalTargets>({});

  const open = (page: LatheConnectAccountPageUrl = "lathe-connect") => {
    const setTarget = (key: string, element: HTMLDivElement | undefined) =>
      setTargets((current) => ({ ...current, [key]: element }));
    clerk.openUserProfile({
      __experimental_startPath: `/${page}`,
      customPages: LATHE_CONNECT_ACCOUNT_PAGES.map((page) => ({
        label: m(page.label),
        url: page.url,
        mount: (element: HTMLDivElement) => setTarget(`content:${page.url}`, element),
        unmount: () => setTarget(`content:${page.url}`, undefined),
        mountIcon: (element: HTMLDivElement) => setTarget(`icon:${page.url}`, element),
        unmountIcon: () => setTarget(`icon:${page.url}`, undefined),
      })),
    });
  };

  const portals = LATHE_CONNECT_ACCOUNT_PAGES.flatMap((page) => {
    const content = targets[`content:${page.url}`];
    const icon = targets[`icon:${page.url}`];
    return [
      content ? createPortal(page.content, content, `content:${page.url}`) : null,
      icon ? createPortal(page.icon, icon, `icon:${page.url}`) : null,
    ];
  });

  return { open: isSignedIn ? open : null, portals };
}
