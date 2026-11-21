import type { ReactNode } from "react";

export function IntegrationGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1 px-1">
        <h2 className="text-base leading-tight font-semibold">{title}</h2>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel/50">
        {children}
      </div>
    </section>
  );
}
