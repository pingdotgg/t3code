import { useAtomValue } from "@effect/atom-react";
import type { InferenceRoutingOptions } from "@t3tools/client-runtime/state/inference-proxy";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, InferenceConsumer, InferenceDriver } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const { inferenceProxy } = serverEnvironment;

export function useEnableInferenceRouting(environmentId: EnvironmentId, environmentLabel: string) {
  const { environments } = useEnvironments();
  const canConnect = useAtomValue(inferenceProxy.canConnect(environmentId));
  const enable = useAtomCommand(inferenceProxy.enableInferenceRouting, { reportFailure: false });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    driver: InferenceDriver,
    options?: InferenceRoutingOptions,
  ): Promise<InferenceConsumer | null> {
    if (!canConnect || inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await enable({
      consumer: { environmentId, label: environmentLabel },
      driver,
      environments,
      ...options,
    });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Success") return result.value;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : String(failure));
    return null;
  }

  return { canConnect, pending, error, run, clearError: () => setError(null) };
}
