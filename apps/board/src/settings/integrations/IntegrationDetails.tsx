import type { ReactNode } from "react";

export function IntegrationDetails({ children }: { children: ReactNode }) {
  return <div className="mt-4 space-y-2 border-t border-line/60 pt-4">{children}</div>;
}
