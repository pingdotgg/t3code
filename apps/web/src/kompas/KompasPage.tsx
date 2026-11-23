import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";

export function KompasPage(props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <SidebarInset
      {...workspaceAreaProps("kompas", 1, gt("Content"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden"
    >
      <WorkspacePageHeader electron={isElectron} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="font-semibold text-2xl tracking-tight">{props.title}</h1>
              {props.description === undefined ? null : (
                <p className="mt-1 text-muted-foreground">{props.description}</p>
              )}
            </div>
            {props.actions}
          </div>
          {props.children}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

export function Panel({
  className,
  ...props
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-5", className)}>
      {props.children}
    </section>
  );
}

export function PanelTitle(props: { readonly children: ReactNode; readonly detail?: ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="font-semibold text-base">{props.children}</h2>
      {props.detail === undefined ? null : (
        <p className="text-muted-foreground text-sm">{props.detail}</p>
      )}
    </div>
  );
}

export function Progress(props: { readonly value: number; readonly label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuenow={Math.round(props.value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-accent"
    >
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${Math.min(1, Math.max(0, props.value)) * 100}%` }}
      />
    </div>
  );
}

export function formatDay(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(iso));
}
