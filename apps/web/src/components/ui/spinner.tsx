import { Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return (
    <Loader2Icon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

function ProgressSpinner({
  value,
  className,
  ...props
}: React.ComponentProps<"svg"> & { value: number }) {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

  return (
    <svg
      viewBox="0 0 24 24"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={progress}
      className={cn("-rotate-90", className)}
      role="progressbar"
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9.75"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.24"
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r="9.75"
        fill="none"
        pathLength="100"
        stroke="currentColor"
        strokeDasharray="100"
        strokeDashoffset={100 - progress}
        strokeLinecap="round"
        strokeWidth="3"
        className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}

export { ProgressSpinner, Spinner };
