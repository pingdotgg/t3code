import type { BotSummary } from "@t3tools/client-runtime/state/bots";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useGT } from "gt-react";
import { memo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { botListAtom } from "../../state/bots";
import { buildThreadRouteParams, isThreadRoutePathname } from "../../threadRoutes";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { BotAvatar } from "./BotAvatar";
import { CreateBotDialog } from "./CreateBotDialog";

const BotRow = memo(function BotRow({
  bot,
  active,
  onOpen,
}: {
  bot: BotSummary;
  active: boolean;
  onOpen: (bot: BotSummary) => void;
}) {
  const gt = useGT();
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onOpen(bot)}
        // oxlint-disable-next-line t3code/no-styled-raw-controls -- A two-line row led by a 40px avatar; sidebar rows are fixed-height.
        className={cn(
          "group/bot flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 text-left outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
          active && "bg-sidebar-row-hover",
        )}
      >
        <BotAvatar avatar={bot.avatar} threadRef={bot.threadRef} className="size-10" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-label text-sidebar-foreground")}>{bot.name}</span>
          <span
            className={cn(
              "truncate text-body",
              bot.unread ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
            )}
          >
            {bot.working ? gt("Working") : (bot.preview ?? gt("No messages yet"))}
          </span>
        </span>
        {bot.unread ? (
          <span aria-label={gt("Unread")} className="size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </button>
    </li>
  );
});

export default function BotsSidebar() {
  const gt = useGT();
  const bots = useAtomValue(botListAtom);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visibleBots =
    needle.length === 0 ? bots : bots.filter((bot) => bot.name.toLowerCase().includes(needle));

  const openBot = (bot: BotSummary) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(bot.threadRef),
    });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <InputGroup size="sidebar" className="min-w-0 flex-1">
                <InputGroupAddon>
                  <span className="-mx-0.5 flex size-4 shrink-0 items-center justify-center">
                    <SearchIcon className="size-[13px] text-(--sidebar-icon-color)" />
                  </span>
                </InputGroupAddon>
                <InputGroupInput
                  nativeInput
                  type="search"
                  aria-label={gt("Search bots")}
                  placeholder={gt("Search")}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setQuery("");
                  }}
                />
              </InputGroup>
              <SidebarHeaderIconButton label={gt("New bot")} onClick={() => setCreating(true)}>
                <PlusIcon />
              </SidebarHeaderIconButton>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          {visibleBots.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-muted-foreground/60">
              {bots.length === 0 ? gt("No bots yet") : gt("No matching bots")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visibleBots.map((bot) => (
                <BotRow
                  key={bot.key}
                  bot={bot}
                  active={isThreadRoutePathname(pathname, bot.threadRef)}
                  onOpen={openBot}
                />
              ))}
            </ul>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
      <CreateBotDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
