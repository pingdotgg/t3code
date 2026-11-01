import type { ReactNode } from "react";

import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

export function RightPanelContentBoundary(props: {
  readonly surfaceId: string;
  readonly children: ReactNode;
}) {
  return (
    <RenderErrorBoundary
      resetKeys={[props.surfaceId]}
      fallback={
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Could not load this panel</EmptyTitle>
            <EmptyDescription>Reload the app to try again.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </Empty>
      }
    >
      {props.children}
    </RenderErrorBoundary>
  );
}
