import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { Badge } from "../ui/badge";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

/** Connections belong to the selected environment's CLI stores, never to the browser. */
export function ForgejoInstanceSettings({ auth }: { readonly auth: SourceControlProviderAuth }) {
  const instances = auth.instances ?? [];
  return (
    <div className="grid gap-4">
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Connections are read from fj and tea on this server. Add each instance with{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">
          fj --host https://your-server auth add-token
        </code>{" "}
        or <code className="rounded bg-muted px-1 py-px text-2xs">tea login add</code>, then rescan.
        Use a full repository URL to choose an instance when cloning or publishing.
      </p>
      {Option.isSome(auth.detail) ? (
        <p className="text-xs text-warning">{auth.detail.value}</p>
      ) : null}
      {instances.length === 0 ? (
        <p className="text-xs text-muted-foreground">No configured instances detected.</p>
      ) : (
        <ul className="grid gap-3" aria-label="Forgejo and Gitea instances">
          {instances.map((instance) => (
            <li key={`${instance.executable}:${instance.login}`} className="grid gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all text-xs font-medium text-foreground">
                  {instance.baseUrl}
                </span>
                <code className="text-2xs text-muted-foreground">{instance.executable}</code>
                <Badge
                  size="sm"
                  variant={instance.status === "authenticated" ? "secondary" : "warning"}
                >
                  {instance.status === "authenticated"
                    ? "Authenticated"
                    : instance.status === "unauthenticated"
                      ? "Not authenticated"
                      : "Status unknown"}
                </Badge>
              </div>
              <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <span>Account</span>
                {Option.isSome(instance.account) ? (
                  <RedactedSensitiveText
                    key={instance.account.value}
                    value={instance.account.value}
                    ariaLabel={`Toggle ${instance.executable} account visibility for ${instance.baseUrl}`}
                    revealTooltip="Click to reveal account"
                    hideTooltip="Click to hide account"
                  />
                ) : (
                  <span>Could not verify username</span>
                )}
              </p>
              {instance.detail ? <p className="text-xs text-warning">{instance.detail}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
