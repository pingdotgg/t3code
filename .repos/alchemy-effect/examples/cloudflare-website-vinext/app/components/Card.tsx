import type { ReactNode } from "react";

// A React component styled with Tailwind utility classes.
export function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm ${className ?? "max-w-md"}`}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 text-slate-600">{children}</div>
    </div>
  );
}
