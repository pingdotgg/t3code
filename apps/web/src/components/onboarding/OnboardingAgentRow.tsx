import type { ReactNode } from "react";

import { Text } from "../ui/text";

export function OnboardingAgentRow({
  icon,
  title,
  description,
  control,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  /** A line under the row's text, inset to it. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="rounded-control border border-border surface-card px-3 py-2.75">
      <div className="flex flex-wrap items-center gap-3">
        {icon}
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
      {children ? <div className="mt-2.5 ps-7.5">{children}</div> : null}
    </div>
  );
}
