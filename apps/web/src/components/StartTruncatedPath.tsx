import { cn } from "~/lib/utils";

export function StartTruncatedPath({ path, className }: { path: string; className?: string }) {
  return (
    <span
      className={cn("min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left", className)}
      dir="rtl"
    >
      <bdi>{path}</bdi>
    </span>
  );
}
