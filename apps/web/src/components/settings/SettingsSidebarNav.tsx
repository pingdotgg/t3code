import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { cn } from "../../lib/utils";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  getVisibleSettingsSectionIds,
  observeSettingsSectionVisibility,
  type SettingsSectionVisibilityState,
} from "./settingsSectionVisibility";
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/connections": Link2Icon,
  "/settings/archived": ArchiveIcon,
};

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsPath;
  icon: ComponentType<{ className?: string }>;
}> = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).map((to) => ({
  to,
  label: SETTINGS_SECTION_LABELS[to],
  icon: SETTINGS_SECTION_ICONS[to],
}));

const SETTINGS_PAGE_SECTIONS: Partial<
  Readonly<Record<SettingsPath, ReadonlyArray<{ label: string; targetId: string }>>>
> = {
  "/settings/general": [
    { label: "Organization", targetId: "organization" },
    { label: "Behavior", targetId: "behavior" },
    { label: "Projects & threads", targetId: "projects-and-threads" },
    { label: "Confirmations", targetId: "confirmations" },
    { label: "Text generation", targetId: "text-generation" },
    { label: "About", targetId: "about" },
    { label: "Legacy features", targetId: "legacy-features" },
  ],
  "/settings/appearance": [
    { label: "Colors & themes", targetId: "appearance" },
    { label: "Interface", targetId: "appearance-interface" },
    { label: "Motion", targetId: "motion" },
    { label: "Typography", targetId: "typography" },
  ],
  "/settings/source-control": [
    { label: "Version control", targetId: "source-control" },
    { label: "Text generation", targetId: "source-control-text-generation" },
  ],
  "/settings/connections": [
    { label: "This environment", targetId: "connections-environment" },
    { label: "Remote environments", targetId: "remote-environments" },
  ],
};

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />;
}

function SettingsSubmenuCollapse({
  open,
  children,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible open={open}>
      <CollapsiblePanel className="duration-150 ease-out motion-reduce:transition-none">
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const resolvedPathname = useRouterState({
    select: (state) => state.resolvedLocation?.pathname,
  });
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [sectionVisibility, setSectionVisibility] = useState<SettingsSectionVisibilityState | null>(
    null,
  );
  const searchableItems = useAvailableSettingsSearchItems();
  const results = useMemo(() => searchSettings(query, searchableItems), [query, searchableItems]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const activeSettingsPath = SETTINGS_NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  )?.to;
  const observedVisibilityScope = useMemo(() => {
    const path = SETTINGS_NAV_ITEMS.find(
      (item) =>
        resolvedPathname === item.to || resolvedPathname?.startsWith(`${item.to}/`) === true,
    )?.to;
    const pageSections = path ? SETTINGS_PAGE_SECTIONS[path] : undefined;
    return path && pageSections ? { path, pageSections } : null;
  }, [resolvedPathname]);
  const visiblePageSectionIds = getVisibleSettingsSectionIds({
    activePath: activeSettingsPath,
    scope: observedVisibilityScope,
    visibility: sectionVisibility,
  });

  useEffect(() => {
    if (!observedVisibilityScope) return;
    const container = document.querySelector<HTMLElement>("[data-settings-page-layout]");
    if (!container) return;

    return observeSettingsSectionVisibility({
      container,
      targetIds: observedVisibilityScope.pageSections.map((section) => section.targetId),
      onChange(targetIds) {
        setSectionVisibility({ scope: observedVisibilityScope, targetIds: new Set(targetIds) });
      },
    });
  }, [observedVisibilityScope]);

  useEffect(() => {
    setActiveResultIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside open dialogs and popups instead of escaping
          // their focus trap into the sidebar search.
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to,
        hash: "",
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handlePageSectionClick = useCallback(
    (to: SettingsPath, targetId: string) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      if (pathname === to && scrollToSettingsTarget(targetId, { highlight: false })) {
        return;
      }
      void navigate({
        to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: false },
      });
    },
    [isMobile, navigate, pathname, setOpenMobile],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to: item.to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <Input
              ref={searchInputRef}
              nativeInput
              unstyled
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveResultIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              aria-label="Search settings"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isSearching && hasResults}
              aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
              aria-activedescendant={
                isSearching && results[activeResultIndex]
                  ? `settings-search-result-${results[activeResultIndex].id}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
            />
            {isSearching ? (
              <Button
                type="button"
                size="icon-micro"
                variant="ghost"
                className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                aria-label="Clear settings search"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">/</Kbd>
            )}
          </div>
          {isSearching && results.length === 0 ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No settings found
            </p>
          ) : null}
          {isSearching ? (
            <SidebarMenu
              className="ps-px"
              id={hasResults ? "settings-search-results" : undefined}
              role={hasResults ? "listbox" : undefined}
              aria-label={hasResults ? "Settings search results" : undefined}
            >
              {results.map((item, index) => (
                <SidebarMenuItem key={item.id} role="presentation">
                  <SidebarMenuButton
                    id={`settings-search-result-${item.id}`}
                    role="option"
                    aria-selected={index === activeResultIndex}
                    tabIndex={-1}
                    size="sm"
                    isActive={index === activeResultIndex}
                    className="h-auto min-h-10 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    onMouseMove={() => setActiveResultIndex(index)}
                    onClick={() => handleSearchResultClick(item)}
                  >
                    <SettingsSectionIcon to={item.to} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-sidebar-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                        {SETTINGS_SECTION_LABELS[item.to]}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <SidebarMenu className="ps-px">
              {SETTINGS_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const pageSections = SETTINGS_PAGE_SECTIONS[item.to];
                const isActive = activeSettingsPath === item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => handleSectionClick(item.to)}
                    >
                      <Icon />
                      <span className="truncate">{item.label}</span>
                    </SidebarMenuButton>
                    {pageSections ? (
                      <SettingsSubmenuCollapse open={isActive}>
                        <SidebarMenuSub className="border-l-0">
                          {pageSections.map((section) => (
                            <SidebarMenuSubItem key={section.targetId}>
                              <SidebarMenuSubButton
                                render={<button type="button" />}
                                size="sm"
                                data-visible={visiblePageSectionIds.has(section.targetId)}
                                className={cn(
                                  "w-full text-sidebar-muted-foreground/65",
                                  visiblePageSectionIds.has(section.targetId) &&
                                    "font-medium text-sidebar-foreground",
                                )}
                                onClick={() => handlePageSectionClick(item.to, section.targetId)}
                              >
                                <span className="ms-0.5">{section.label}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </SettingsSubmenuCollapse>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarUtilityMenu />
          </div>
          <Suspense fallback={null}>
            <T3ConnectSidebarAvatar />
          </Suspense>
        </div>
      </SidebarFooter>
    </>
  );
}
