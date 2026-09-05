import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/utils";

export function UsageBreakdownTable({
  firstColumnHeading,
  children,
}: {
  readonly firstColumnHeading: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-[32%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">{firstColumnHeading}</th>
          <th className="py-2 text-right font-normal">Cost</th>
          <th className="py-2 text-right font-normal">Cache writes</th>
          <th className="py-2 text-right font-normal">Share</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function UsageBreakdownRow({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return (
    <tr
      className={cn("border-b border-border/50 transition-colors hover:bg-muted/50", className)}
      {...props}
    />
  );
}
