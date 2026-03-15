import { type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { PROVIDER_OPTIONS } from "~/session-logic";
import { ensureSentenceEnds } from "~/lib/utils";

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
}: {
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const defaultMessage =
    status.status === "error"
      ? `${status.provider} provider is unavailable.`
      : `${status.provider} provider has limited availability.`;

  const opts = PROVIDER_OPTIONS.find((opt) => opt.value === status.provider);

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>
          {status.provider === "codex" ? "Codex provider status" : `${status.provider} status`}
        </AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {ensureSentenceEnds(status.message ?? defaultMessage)}
          {opts?.docsUrl ? (
            <>
              {" "}
              <a
                className="underline underline-offset-4 text-foreground hover:text-primary"
                href={opts.docsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Installation Guide
              </a>
            </>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
});
