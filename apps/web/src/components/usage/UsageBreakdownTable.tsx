import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "../ui/table";

export function UsageBreakdownTable({
  firstColumnHeading,
  children,
}: {
  readonly firstColumnHeading: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Table className="table-fixed text-sm">
      <colgroup>
        <col className="w-[32%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
        <col className="w-[17%]" />
      </colgroup>
      <TableHeader>
        <TableRow className="border-border text-left text-xs text-muted-foreground hover:bg-transparent">
          <TableHead className="h-auto px-0 py-2 font-normal text-muted-foreground">
            {firstColumnHeading}
          </TableHead>
          <TableHead className="h-auto px-0 py-2 text-right font-normal text-muted-foreground">
            Cost
          </TableHead>
          <TableHead className="h-auto px-0 py-2 text-right font-normal text-muted-foreground">
            Cache writes
          </TableHead>
          <TableHead className="h-auto px-0 py-2 text-right font-normal text-muted-foreground">
            Share
          </TableHead>
          <TableHead className="h-auto px-0 py-2 text-right font-normal text-muted-foreground">
            Tokens
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr:last-child]:border-b">{children}</TableBody>
    </Table>
  );
}

export function UsageBreakdownRow({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return <TableRow className={cn("border-border/50", className)} {...props} />;
}
