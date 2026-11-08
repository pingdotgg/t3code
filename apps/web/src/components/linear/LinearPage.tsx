import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarInset } from "../ui/sidebar";
import { LinearSelect, LinearMessage } from "./LinearControls";
import { LinearWorkspace } from "./LinearWorkspace";

export function LinearPage() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((env) => env.environmentId === selected) ??
    environments.find(
      (env) => env.environmentId === primary && env.serverConfig?.environment.capabilities.linear,
    ) ??
    environments.find(
      (env) =>
        env.connection.phase === "connected" && env.serverConfig?.environment.capabilities.linear,
    ) ??
    environments.find((env) => env.serverConfig?.environment.capabilities.linear) ??
    environments.find((env) => env.environmentId === primary) ??
    environments[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      {environments.length > 1 && (
        <div className="flex shrink-0 justify-end border-b px-5 py-2">
          <LinearSelect
            label="Environment"
            value={environment?.environmentId ?? ""}
            options={environments.map((env) => ({ id: env.environmentId, name: env.label }))}
            onChange={(id) =>
              setSelected(
                environments.find((env) => env.environmentId === id)?.environmentId ?? null,
              )
            }
          />
        </div>
      )}
      {environment?.serverConfig?.environment.capabilities.linear ? (
        <LinearWorkspace
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <LinearMessage>
          {environment?.serverConfig
            ? "Update this environment’s T3 server to use the Linear integration."
            : "Connect an environment to open Linear."}
        </LinearMessage>
      )}
    </SidebarInset>
  );
}
