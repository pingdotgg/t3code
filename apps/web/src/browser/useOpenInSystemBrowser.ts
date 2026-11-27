import { AuthTerminalOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { useEnvironment } from "~/state/environments";
import {
  canForwardPorts,
  forwardedUrl,
  forwardPort,
  useForwardLocality,
} from "~/state/portForwards";
import { useEnvironmentScope } from "~/state/session";

import { tunnelsEnvironmentLoopback } from "./browserTargetResolver";

/** The port of an http(s) URL on localhost, 127.0.0.1 or ::1; null for any other URL. */
export function loopbackWebPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

/**
 * Opens a URL from an environment's output in the system browser. That browser reaches another
 * machine's loopback only through a forward, so those URLs open through one or not at all.
 */
export function useOpenInSystemBrowser(
  environmentId: EnvironmentId | null,
): (url: string) => Promise<void> {
  const environment = useEnvironment(environmentId);
  const forwardable =
    useEnvironmentScope(environmentId, AuthTerminalOperateScope) &&
    environment?.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? environmentId : null);
  return async (url) => {
    const api = readLocalApi();
    if (!api) throw new Error(m(msg("Link opening is unavailable.")));
    const port = loopbackWebPort(url);
    if (
      environmentId === null ||
      port === null ||
      locality === "local" ||
      !tunnelsEnvironmentLoopback(environment?.entry.target)
    ) {
      await api.shell.openExternal(url);
      return;
    }
    if (!forwardable) {
      throw new Error(
        m(
          msg(
            "localhost:{port} runs on another machine, and port forwarding isn't available for it right now.",
            { port },
          ),
        ),
      );
    }
    // Starting a forward runs the probe; only a confirmed local environment opens directly.
    const forward = await forwardPort(environmentId, port);
    await api.shell.openExternal(forwardedUrl(forward, url));
  };
}
