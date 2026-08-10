import { cn } from "~/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted [--skeleton-highlight:--alpha(var(--color-white)/64%)] after:absolute after:inset-0 after:animate-skeleton after:bg-[linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
