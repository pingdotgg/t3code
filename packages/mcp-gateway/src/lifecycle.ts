import type { GatewayRuntimePort } from "./port.ts";

export interface GatewayRuntimeHandle {
  stop(): Promise<void>;
}

export interface GatewayRuntimeModule {
  start(port: GatewayRuntimePort): Promise<GatewayRuntimeHandle>;
}

export type GatewayStatus =
  | { readonly state: "disabled" }
  | { readonly state: "starting" }
  | { readonly state: "running" }
  | { readonly state: "degraded"; readonly message: string };

export function createGatewayController(input: {
  readonly port: GatewayRuntimePort;
  readonly load: () => Promise<GatewayRuntimeModule>;
}) {
  let current: GatewayStatus = { state: "disabled" };
  const handles = new Set<GatewayRuntimeHandle>();
  let generation = 0;
  let stopping: Promise<void> | undefined;
  const hasActiveRuntime = () => current.state === "running" || current.state === "starting";

  const cleanupFailure = (error: unknown): GatewayStatus => ({
    state: "degraded",
    message: `Failed to stop MCP gateway: ${error instanceof Error ? error.message : String(error)}`,
  });

  const stopAll = async (): Promise<void> => {
    generation += 1;
    const failures: unknown[] = [];
    for (const running of handles) {
      try {
        await running.stop();
        handles.delete(running);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      current = { state: "disabled" };
      return;
    }
    current = cleanupFailure(failures[0]);
    throw failures[0];
  };

  return {
    status: () => current,
    enable: async (): Promise<GatewayStatus> => {
      if (stopping) {
        try {
          await stopping;
        } catch {
          return current;
        }
      }
      if (hasActiveRuntime()) return current;
      if (handles.size > 0) return current;
      const enableGeneration = ++generation;
      current = { state: "starting" };
      try {
        const module = await input.load();
        if (generation !== enableGeneration) return current;
        const started = await module.start(input.port);
        handles.add(started);
        if (generation !== enableGeneration) {
          try {
            await started.stop();
            handles.delete(started);
          } catch (error) {
            if (!hasActiveRuntime()) {
              current = cleanupFailure(error);
            }
          }
          return current;
        }
        current = { state: "running" };
      } catch (error) {
        if (generation === enableGeneration) {
          current = {
            state: "degraded",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return current;
    },
    disable: (): Promise<void> => {
      stopping ??= stopAll().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}
