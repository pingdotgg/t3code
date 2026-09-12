import { Smartphone } from "lucide-react";

import { Spinner } from "~/components/ui/spinner";

export function DeviceLoadingView(props: {
  readonly name: string;
  readonly description?: string;
  readonly stage: "opening" | "stream";
  readonly message: string;
  readonly error?: boolean;
}) {
  return (
    <div
      role={props.error ? "alert" : "status"}
      className="flex size-full items-center justify-center bg-background px-6 py-10"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-xl border bg-muted/30">
          <Smartphone className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{props.name}</p>
          {props.description ? (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {!props.error ? <Spinner className="size-3" /> : null}
          <span>{props.message}</span>
        </div>
        {!props.error ? (
          <div
            className="flex w-24 gap-1"
            aria-label={
              props.stage === "opening" ? "Step 1 of 2: open device" : "Step 2 of 2: connect video"
            }
          >
            <span className="h-1 flex-1 rounded-full bg-foreground/60" />
            <span
              className={`h-1 flex-1 rounded-full ${props.stage === "stream" ? "bg-foreground/60" : "bg-muted"}`}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
