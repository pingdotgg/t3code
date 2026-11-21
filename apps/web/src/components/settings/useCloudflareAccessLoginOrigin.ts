import { fetchCloudflareAccessLoginAvailable } from "@t3tools/client-runtime/cloudflare-access-login";
import { cloudflareAccessLoginOrigin } from "@t3tools/shared/cloudflareAccessLogin";
import { useEffect, useState } from "react";

const PROBE_DELAY_MS = 400;

/** The typed host's https origin once its server says it offers Cloudflare Access sign-in. */
export function useCloudflareAccessLoginOrigin(host: string, enabled: boolean): string | null {
  const origin = enabled ? cloudflareAccessLoginOrigin(host) : null;
  const [probe, setProbe] = useState<{ readonly origin: string; readonly ok: boolean } | null>(
    null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the typed server whether it offers Access sign-in, after typing settles
  useEffect(() => {
    if (origin === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchCloudflareAccessLoginAvailable(origin, controller.signal).then((ok) => {
        if (!controller.signal.aborted) setProbe({ origin, ok });
      });
    }, PROBE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [origin]);
  return probe !== null && probe.ok && probe.origin === origin ? origin : null;
}
