import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Text } from "../ui/text";

export function OnboardingAgentRow({
  driver,
  title,
  description,
  control,
}: {
  readonly driver: ProviderDriverKind;
  readonly title: string;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-control border border-border surface-card px-3 py-2.75">
      <ProviderInstanceIcon driverKind={driver} displayName={title} iconClassName="size-4.5" />
      <div className="min-w-0 flex-1 basis-32">
        <Text variant="label" render={<p />}>
          {title}
        </Text>
        <div className="mt-0.5 break-words whitespace-pre-wrap">
          <Text variant="meta" tone="muted" render={<p />}>
            {description}
          </Text>
        </div>
      </div>
      {control ? <div className="ms-auto max-w-full shrink-0">{control}</div> : null}
    </div>
  );
}
