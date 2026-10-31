import type { EnvironmentId } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { ExternalLinkIcon } from "lucide-react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { T3AppIcon } from "./T3AppIcon";
import { InlineButton } from "./ui/button";

/**
 * Says when the server's forge app sign-in cannot reach `repository`, so requests there fall back
 * to the user's own login. Renders nothing for servers that do not use the app.
 */
export function SourceControlAppAccessNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: string | undefined;
  readonly host: string | undefined;
  /** `owner/name`. */
  readonly repository: string;
  readonly className?: string;
}) {
  const definition = props.provider ? sourceControlClients.find(props.provider) : undefined;
  const appSignIn = definition?.credentials?.appSignIn;
  const host = (props.host ?? definition?.publicHost ?? "").toLowerCase();
  const signedIn = useEnvironmentSettings(props.environmentId, (settings) =>
    definition === undefined
      ? false
      : (readHostCredentialSettings(settings, definition.kind).signIns[host] ?? "").length > 0,
  );
  const access = useEnvironmentQuery(
    definition !== undefined && appSignIn?.hosts.includes(host) && signedIn
      ? sourceControlEnvironment.appAccess({
          environmentId: props.environmentId,
          input: { provider: definition.kind, host, repository: props.repository },
        })
      : null,
  );
  if (appSignIn === undefined || access.data?.status !== "not-covered") return null;
  const owner = props.repository.split("/")[0] ?? props.repository;

  return (
    <div
      role="note"
      className={cn(
        "flex items-center gap-2.5 bg-muted/40 px-4 py-2 text-xs text-muted-foreground",
        props.className,
      )}
    >
      <T3AppIcon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {appSignIn.appName} isn't installed on <span className="text-foreground">{owner}</span>, so
        requests here use your own GitHub login and its lower rate limit.
      </p>
      <InlineButton
        className="shrink-0"
        render={<a href={appSignIn.installUrl} target="_blank" rel="noreferrer noopener" />}
      >
        Install on {owner}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </InlineButton>
    </div>
  );
}
