import type { ReactNode } from "react";

import { Text } from "~/components/ui/text";

/**
 * A dim meta heading over a group of content, such as "Local servers" above a
 * list of server cards. The section owns the heading and the gap below it;
 * callers pass the label and the content.
 */
export function LabeledSection({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <Text variant="meta" tone="dim" render={<h3 />}>
        {label}
      </Text>
      {children}
    </section>
  );
}
