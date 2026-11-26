// Fork: Kaluwa's Extensions page. A subscription's dead skill links, as one thing to clean up.
import type { ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { Link2OffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { FixWithAiButton } from "./ExtensionActions";
import { useExtensions } from "./extensionsContext";
import { BROKEN_LINKS_PENDING_KEY, brokenSkillLinks } from "./extensionsModel";
import { EditButton } from "./extensionsParts";

export function BrokenLinksRow({
  subscription,
  lead,
}: {
  readonly subscription: ExtensionsSubscription;
  /** Shown before the text, in lists that mix subscriptions. */
  readonly lead?: ReactNode;
}) {
  const gt = useGT();
  const { run, isPending } = useExtensions();
  const links = brokenSkillLinks(subscription);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <span className="flex min-w-48 flex-1 items-start gap-2.5">
        <span className="flex h-5 items-center">
          {lead ?? (
            <Link2OffIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">
            {gt(
              "{count, plural, one {{count} skill link points to a skill that no longer exists} other {{count} skill links point to skills that no longer exist}}",
              { count: links.length },
            )}
          </span>
          <span className="line-clamp-2 wrap-anywhere text-xs text-muted-foreground">
            {links.map((link) => link.name).join(", ")}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center justify-end gap-1.5">
        <EditButton
          size="xs"
          variant="outline"
          busy={isPending(subscription.instanceId, BROKEN_LINKS_PENDING_KEY)}
          busyLabel={gt("Removing…")}
          onClick={() =>
            void run([{ _tag: "SkillRemoveBrokenLinks", instanceId: subscription.instanceId }])
          }
        >
          <T>Remove broken links</T>
        </EditButton>
        <FixWithAiButton problem={{ type: "brokenLinks", links }} subscription={subscription} />
      </span>
    </div>
  );
}
