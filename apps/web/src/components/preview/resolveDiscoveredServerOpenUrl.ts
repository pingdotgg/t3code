import type {
  DiscoveredLocalServer,
  EnvironmentId,
  PreviewProbeDiscoveredServerTlsInput,
  PreviewProbeDiscoveredServerTlsResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";

export type ProbeDiscoveredServerTlsMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewProbeDiscoveredServerTlsInput;
}) => Promise<AtomCommandResult<PreviewProbeDiscoveredServerTlsResult, E>>;

/**
 * Discovered listeners are listed as plain HTTP, so an HTTPS-only dev server would open
 * at http:// and fail. On click, probe the listener for TLS and upgrade the scheme when
 * it speaks TLS; any probe failure keeps the listed URL.
 */
export async function resolveDiscoveredServerOpenUrl<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly probeTls: ProbeDiscoveredServerTlsMutation<E>;
}): Promise<string> {
  const url = input.port.url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)) return url;
  // Probe the listener the URL will open, not the discovered record's host: a configured
  // URL can name a different loopback address (127.0.0.1 vs localhost) than the record.
  // `http://localhost:80` drops the default port when parsed, so record the effective
  // port before switching schemes or the upgrade would target 443.
  const port = parsed.port === "" ? "80" : parsed.port;
  const result = await input
    .probeTls({
      environmentId: input.threadRef.environmentId,
      input: { host: parsed.hostname, port: Number(port) },
    })
    .catch(() => null);
  if (result?._tag !== "Success" || !result.value.tls) return url;
  parsed.protocol = "https:";
  parsed.port = port;
  return parsed.toString();
}
