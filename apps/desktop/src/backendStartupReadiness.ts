import { isBackendReadinessAborted } from "./backendReadiness.ts";

export interface WaitForBackendStartupReadyOptions {
  readonly listeningPromise?: Promise<void> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly cancelHttpWait: () => void;
}

export async function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions,
): Promise<"listening" | "http"> {
  const httpReadyPromise = options.waitForHttpReady();
  const listeningPromise = options.listeningPromise;

  if (!listeningPromise) {
    await httpReadyPromise;
    return "http";
  }

  return await new Promise<"listening" | "http">((resolve, reject) => {
    let settled = false;

    const settleResolve = (source: "listening" | "http") => {
      if (settled) {
        return;
      }
      settled = true;
      if (source === "listening") {
        options.cancelHttpWait();
      }
      resolve(source);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    listeningPromise.then(
      () => settleResolve("listening"),
      (error) => settleReject(error),
    );
    httpReadyPromise.then(
      () => settleResolve("http"),
      (error) => {
        if (settled && isBackendReadinessAborted(error)) {
          return;
        }
        settleReject(error);
      },
    );
  });
}
