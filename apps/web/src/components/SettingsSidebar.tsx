import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { SidebarContent, SidebarHeader } from "~/components/ui/sidebar";

const SETTINGS_SECTIONS = [
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-codex-app-server", label: "Codex App Server" },
  { id: "settings-models", label: "Models" },
  { id: "settings-responses", label: "Responses" },
  { id: "settings-keybindings", label: "Keybindings" },
  { id: "settings-safety", label: "Safety" },
] as const;

export default function SettingsSidebar() {
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS[0].id);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const sectionIds = SETTINGS_SECTIONS.map((s) => s.id);

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observerRef.current.observe(el);
    }

    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <>
      <SidebarHeader className="h-[52px] border-b border-border p-0" />

      <SidebarContent className="p-0">
        <nav className="flex flex-col px-3 pt-6" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((section) => {
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => scrollToSection(section.id)}
                className={cn(
                  "relative flex w-full items-center rounded-md py-1.5 pl-4 pr-3 text-sm transition-colors",
                  isActive
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {isActive && (
                  <span className="absolute left-1 top-1/2 h-[1.1rem] w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                )}
                {section.label}
              </button>
            );
          })}
        </nav>
      </SidebarContent>
    </>
  );
}
