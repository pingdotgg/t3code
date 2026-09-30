import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  Link2Icon,
  SearchIcon,
  Settings2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import { searchSettings, type SettingsSearchItem, type SettingsPath } from "./settingsSearch";

export type SettingsSectionPath = SettingsPath;

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Agent Workflows", to: "/settings/workflows", icon: WorkflowIcon },
  {
    label: "PR collaboration",
    to: "/settings/pull-request-collaboration",
    icon: WorkflowIcon,
  },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(() => searchSettings(query), [query]);
  const isSearching = query.trim().length > 0;

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"], [aria-modal="true"], [data-slot$="popup"]',
        ) ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      if (isMobile) setOpenMobile(true);
      else if (!open) setOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  useEffect(() => {
    document
      .getElementById(`settings-search-result-${activeResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) setOpenMobile(false);
      if (pathname === item.to && currentHash.replace(/^#/, "") === item.id) {
        scrollToSettingsTarget(item.id);
        return;
      }
      void navigate({
        to: item.to,
        hash: item.id,
        replace: true,
        hashScrollIntoView: false,
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
      } else if (event.key === "ArrowDown" && results.length > 0) {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
      } else if (event.key === "ArrowUp" && results.length > 0) {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
      } else if (event.key === "Enter" && results[activeResultIndex]) {
        event.preventDefault();
        handleResultClick(results[activeResultIndex]);
      }
    },
    [activeResultIndex, clearSearch, handleResultClick, isSearching, results],
  );
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      clearSearch();
      void navigate({ to, hash: "", replace: true, hashScrollIntoView: false });
    },
    [clearSearch, isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <div className="mb-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
            <SearchIcon className="size-4 shrink-0" />
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
              aria-expanded={isSearching && results.length > 0}
              aria-controls={
                isSearching && results.length > 0 ? "settings-search-results" : undefined
              }
              aria-activedescendant={
                isSearching && results[activeResultIndex]
                  ? `settings-search-result-${activeResultIndex}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:text-[13px] [&_[data-slot=input]]:outline-none"
            />
            {isSearching ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Clear settings search"
                className="size-5 shrink-0"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <kbd className="rounded border border-border px-1 text-[10px]">/</kbd>
            )}
          </div>
          {isSearching && results.length === 0 ? (
            <p role="status" className="px-2 py-5 text-center text-xs text-muted-foreground">
              No settings found
            </p>
          ) : null}
          <SidebarMenu
            id={isSearching && results.length > 0 ? "settings-search-results" : undefined}
            role={isSearching && results.length > 0 ? "listbox" : undefined}
            aria-label={isSearching && results.length > 0 ? "Settings search results" : undefined}
          >
            {isSearching
              ? results.map((item, index) => {
                  const Icon = SETTINGS_NAV_ITEMS.find((navItem) => navItem.to === item.to)?.icon;
                  return (
                    <SidebarMenuItem key={`${item.to}-${item.id}`} role="presentation">
                      <SidebarMenuButton
                        id={`settings-search-result-${index}`}
                        role="option"
                        aria-selected={index === activeResultIndex}
                        tabIndex={-1}
                        size="sm"
                        isActive={index === activeResultIndex}
                        className="h-auto min-h-10 items-start gap-2 px-2.5 py-2 text-left"
                        onMouseMove={() => setActiveResultIndex(index)}
                        onClick={() => handleResultClick(item)}
                      >
                        {Icon ? <Icon className="mt-0.5 size-3.5 shrink-0" /> : null}
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium">
                            {item.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {SETTINGS_NAV_ITEMS.find((navItem) => navItem.to === item.to)?.label}
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })
              : SETTINGS_NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={isActive}
                        className={
                          isActive
                            ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                            : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                        }
                        onClick={() => handleSectionClick(item.to)}
                      >
                        <Icon
                          className={
                            isActive
                              ? "size-4 shrink-0 text-foreground"
                              : "size-4 shrink-0 text-muted-foreground/60"
                          }
                        />
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
