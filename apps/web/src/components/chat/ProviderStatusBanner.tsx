import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status !== "error" || status.auth.status !== "unauthenticated") {
    return null;
  }

  const providerName = status.displayName;
  const title = `${providerName} is unauthenticated`;
  const message = "Sign in via the CLI to authenticate again.";

  return (
    <div className="mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "inline-flex items-center gap-3 rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
          "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive",
        )}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <div className="line-clamp-3 text-muted-foreground" title={message}>
            {message}
          </div>
        </div>
      </div>
    </div>
  );
});
