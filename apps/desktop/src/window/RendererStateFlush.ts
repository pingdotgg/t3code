export type RendererStateFlushResult = "flushed" | "failed" | "timed-out";

export interface RendererStateFlushAcknowledgement {
  readonly sender: unknown;
  readonly requestId: unknown;
  readonly succeeded: unknown;
}

export function requestRendererStateFlush(input: {
  readonly requestId: string;
  readonly target: unknown;
  readonly signal?: AbortSignal;
  readonly send: (requestId: string) => void;
  readonly subscribe: (
    listener: (acknowledgement: RendererStateFlushAcknowledgement) => void,
  ) => () => void;
}): Promise<RendererStateFlushResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const handleAbort = () => finish("timed-out");
    const finish = (result: RendererStateFlushResult) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", handleAbort);
      unsubscribe();
      resolve(result);
    };

    try {
      unsubscribe = input.subscribe(({ sender, requestId, succeeded }) => {
        if (sender !== input.target || requestId !== input.requestId) {
          return;
        }
        finish(succeeded === true ? "flushed" : "failed");
      });
      input.signal?.addEventListener("abort", handleAbort, { once: true });
      input.send(input.requestId);
    } catch {
      finish("failed");
    }
  });
}
