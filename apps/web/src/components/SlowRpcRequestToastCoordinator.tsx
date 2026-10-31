import { type SlowRpcAckRequest, subscribeSlowRpcAckRequests } from "../rpc/requestLatencyState";
import { useEnvironments } from "../state/environments";
import { toastManager } from "./ui/toast";

function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

function SlowRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  const { environments } = useEnvironments();
  const environmentLabels = new Map<string, string>(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );

  return (
    <ul className="space-y-2.5 text-meta text-muted-foreground">
      {requests.map((request) => {
        // Name the environment by its label rather than its id.
        const environmentLabel = request.environmentId
          ? environmentLabels.get(request.environmentId)
          : undefined;
        const label = environmentLabel ? `${request.method} · ${environmentLabel}` : request.tag;
        return (
          <li
            className="min-w-0 border-border border-b pb-2 last:border-b-0 last:pb-0"
            key={request.requestId}
          >
            <div className="wrap-break-word text-foreground">{label}</div>
            <div className="mt-0.5 text-caption text-dim-foreground">
              Started {new Date(request.startedAt).toLocaleTimeString()}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** One warning toast that tracks the set of slow requests while any are outstanding. */
export function startSlowRpcRequestToasts(): () => void {
  let toastId: ReturnType<typeof toastManager.add> | null = null;

  const unsubscribe = subscribeSlowRpcAckRequests((slowRequests) => {
    if (slowRequests.length === 0) {
      if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }
      return;
    }

    const nextToast = {
      data: {
        expandableContent: <SlowRequestDetails requests={slowRequests} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
      },
      description: describeSlowRequests(slowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };

    if (toastId === null) {
      toastId = toastManager.add(nextToast);
    } else {
      toastManager.update(toastId, nextToast);
    }
  });

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
