import { CheckIcon, UserIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ClaudeProfileBadgeProps {
  readonly compact?: boolean;
}

export function ClaudeProfileBadge({ compact }: ClaudeProfileBadgeProps) {
  const settings = useSettings();
  const claude = settings.providers.claudeAgent;
  const profiles = claude.profiles;
  const { updateSettings } = useUpdateSettings();

  const activeProfile =
    profiles.find((profile) => profile.id === claude.defaultProfileId) ?? profiles[0];

  const handleSelect = useCallback(
    (profileId: string) => {
      if (profileId === claude.defaultProfileId) return;
      updateSettings({
        providers: {
          ...settings.providers,
          claudeAgent: {
            ...claude,
            defaultProfileId: profileId,
          },
        },
      });
    },
    [claude, settings.providers, updateSettings],
  );

  const label = useMemo(() => activeProfile?.label ?? "Claude", [activeProfile]);

  if (!activeProfile) return null;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground",
          compact ? "h-6" : "h-7",
        )}
        aria-label={`Claude profile: ${label}`}
      >
        <UserIcon className="size-3" aria-hidden />
        <span className="max-w-24 truncate font-medium">{label}</span>
      </PopoverTrigger>
      <PopoverPopup className="w-64 p-2" align="start" side="top">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Claude profile
        </div>
        <div className="flex flex-col">
          {profiles.map((profile) => {
            const isActive = profile.id === activeProfile.id;
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => handleSelect(profile.id)}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/40",
                  isActive && "text-foreground",
                )}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{profile.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {profile.homePath || "default (~/.claude)"}
                  </div>
                </div>
                {isActive ? (
                  <CheckIcon className="size-3 shrink-0 text-foreground" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="mt-2 border-t border-border/50 px-2 pt-2">
          <p className="text-[11px] text-muted-foreground">
            Selecting a profile sets it as the default Claude profile.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
