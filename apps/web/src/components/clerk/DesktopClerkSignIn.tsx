import { LoaderCircleIcon } from "lucide-react";

import type {
  DesktopCloudAuthOAuthOption,
  DesktopCloudAuthOAuthStrategy,
} from "../../cloud/desktopAuth";
import { cn } from "../../lib/utils";
import {
  DesktopClerkAlert,
  DesktopClerkCard,
  DesktopClerkFooterAction,
  DesktopClerkHeader,
} from "./DesktopClerkCard";
import { useDesktopClerkSignIn } from "./useDesktopClerkSignIn";

// Mirrors Clerk's compact social-button layout while delegating OAuth to the desktop bridge:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/elements/SocialButtons.tsx
export function DesktopClerkSignIn({ onJoinWaitlist }: { onJoinWaitlist: () => void }) {
  const { isStarting, oauthOptions, startingStrategy, startOAuth } = useDesktopClerkSignIn();

  return (
    <DesktopClerkSignInCard
      isStarting={isStarting}
      oauthOptions={oauthOptions}
      startingStrategy={startingStrategy}
      onJoinWaitlist={onJoinWaitlist}
      onStartOAuth={(strategy) => void startOAuth(strategy)}
    />
  );
}

export function DesktopClerkSignInCard({
  isStarting,
  oauthOptions,
  startingStrategy,
  onJoinWaitlist,
  onStartOAuth,
}: {
  isStarting: boolean;
  oauthOptions: readonly DesktopCloudAuthOAuthOption[];
  startingStrategy: DesktopCloudAuthOAuthStrategy | null;
  onJoinWaitlist: () => void;
  onStartOAuth: (strategy: DesktopCloudAuthOAuthStrategy) => void;
}) {
  return (
    <DesktopClerkCard
      footerAction={
        <DesktopClerkFooterAction actionLabel="Join waitlist" onAction={onJoinWaitlist}>
          Want early access?
        </DesktopClerkFooterAction>
      }
    >
      <DesktopClerkHeader
        title="Sign in to T3 Code"
        subtitle="Welcome back! Please sign in to continue"
      />
      {oauthOptions.length === 0 ? (
        <DesktopClerkAlert>No OAuth providers are enabled for desktop sign-in.</DesktopClerkAlert>
      ) : (
        <DesktopClerkSocialButtons
          isStarting={isStarting}
          oauthOptions={oauthOptions}
          startingStrategy={startingStrategy}
          onStartOAuth={onStartOAuth}
        />
      )}
    </DesktopClerkCard>
  );
}

function DesktopClerkSocialButtons({
  isStarting,
  oauthOptions,
  startingStrategy,
  onStartOAuth,
}: {
  isStarting: boolean;
  oauthOptions: readonly DesktopCloudAuthOAuthOption[];
  startingStrategy: DesktopCloudAuthOAuthStrategy | null;
  onStartOAuth: (strategy: DesktopCloudAuthOAuthStrategy) => void;
}) {
  const useBlockButtons = oauthOptions.length <= 2;

  return (
    <div className={cn("grid gap-2", useBlockButtons ? "grid-cols-1" : "grid-cols-3")}>
      {oauthOptions.map((option) => {
        const isCurrent = option.strategy === startingStrategy;
        return (
          <button
            key={option.strategy}
            type="button"
            aria-label={`Continue with ${option.label}`}
            className={cn(
              "flex h-10 cursor-pointer items-center justify-center rounded-md border border-input bg-popover px-3 text-sm font-semibold text-foreground shadow-xs outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-64",
              useBlockButtons && "w-full",
            )}
            disabled={isStarting}
            onClick={() => onStartOAuth(option.strategy)}
          >
            <span
              className={cn(
                "flex min-w-0 items-center justify-center gap-3",
                useBlockButtons && "w-full",
              )}
            >
              {isCurrent ? (
                <LoaderCircleIcon className="size-4 animate-spin opacity-70" />
              ) : (
                <DesktopClerkProviderIcon option={option} />
              )}
              {useBlockButtons ? (
                <span className="truncate">
                  {oauthOptions.length === 1 ? `Continue with ${option.label}` : option.label}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DesktopClerkProviderIcon({ option }: { option: DesktopCloudAuthOAuthOption }) {
  if (!option.iconUrl) {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[9px] font-bold text-muted-foreground"
      >
        {option.label.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  if (["apple", "github", "vercel"].includes(option.providerId)) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 bg-foreground"
        style={{
          WebkitMask: `url(${option.iconUrl}) center / cover no-repeat`,
          mask: `url(${option.iconUrl}) center / cover no-repeat`,
        }}
      />
    );
  }

  return <img alt="" aria-hidden className="size-4 shrink-0" src={option.iconUrl} />;
}
