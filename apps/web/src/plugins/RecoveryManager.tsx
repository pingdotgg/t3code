import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { builtinPluginDefinitions, PluginRecoveryContext } from "./features";
import { pluginEnvironment, usePluginSnapshot } from "./state";
import { reloadDesktopPlugins, setDesktopPluginEnabled, useDesktopPlugins } from "./desktop";

/** The host's recovery plane remains usable when interface plugins are disabled. */
export function PluginRecoveryManager() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary ?? environments[0]?.environmentId ?? null;
  const snapshot = usePluginSnapshot(environmentId);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plugins = snapshot._tag === "Success" ? snapshot.value.plugins : [];
  const desktop = useDesktopPlugins();
  const disabledInterface = plugins.some(
    (plugin) =>
      plugin.source === "builtin" &&
      !plugin.enabled &&
      !plugin.manifest.id.startsWith("t3.provider."),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown and recovery event listeners that open the recovery dialog
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("t3:plugin:recover", onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("t3:plugin:recover", onOpen);
    };
  }, []);
  const disabledDesktop =
    desktop.snapshot?.plugins.some((plugin) => plugin.source === "builtin" && !plugin.enabled) ??
    false;
  if (!open && !disabledInterface && !disabledDesktop) return null;
  const definitions = builtinPluginDefinitions();
  return (
    <PluginRecoveryContext value={true}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-3 right-3 z-[1000] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md"
        >
          <T>Plugin recovery</T>
        </button>
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={gt("Plugin recovery")}
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
        >
          <div className="max-h-[80dvh] w-full max-w-xl overflow-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h1 className="text-lg font-semibold">
                <T>Plugin recovery</T>
              </h1>
              <button
                type="button"
                aria-label={gt("Close plugin recovery")}
                onClick={() => setOpen(false)}
              >
                <T>Close</T>
              </button>
            </div>
            <label className="mb-4 block">
              <T>Environment</T>{" "}
              <select
                aria-label={gt("Recovery environment")}
                value={environmentId ?? ""}
                onChange={(event) => setSelected(EnvironmentId.make(event.target.value))}
                className="ms-2 rounded border border-border bg-background p-1"
              >
                {environments.map((environment) => (
                  <option key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <p role="alert" className="mb-3 text-destructive">
                {error}
              </p>
            ) : null}
            {plugins.map((plugin) => (
              <div
                key={plugin.manifest.id}
                className="flex items-center justify-between gap-4 border-b border-border py-3"
              >
                <div>
                  <p>{plugin.manifest.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {gt(
                      "{id} · {count, plural, one {{count} loaded interface contribution} other {{count} loaded interface contributions}}",
                      {
                        id: plugin.manifest.id,
                        count:
                          definitions.find((definition) => definition.id === plugin.manifest.id)
                            ?.slots.length ?? 0,
                      },
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={pending !== null || environmentId === null}
                  className="rounded border border-border px-3 py-1 disabled:opacity-50"
                  onClick={() => {
                    if (!environmentId) return;
                    setPending(plugin.manifest.id);
                    setError(null);
                    void runAtomCommand(appAtomRegistry, pluginEnvironment.setEnabled, {
                      environmentId,
                      input: { id: plugin.manifest.id, enabled: !plugin.enabled },
                    })
                      .then((result) => {
                        if (result._tag === "Failure")
                          setError(String(squashAtomCommandFailure(result)));
                      })
                      .finally(() => setPending(null));
                  }}
                >
                  {pending === plugin.manifest.id ? (
                    <T>Updating...</T>
                  ) : plugin.enabled ? (
                    <T>Disable</T>
                  ) : (
                    <T>Enable</T>
                  )}
                </button>
              </div>
            ))}
            {!plugins.length ? (
              <p>
                <T>Connect an environment to manage its plugins.</T>
              </p>
            ) : null}
            {desktop.available ? (
              <section className="mt-5">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-base font-semibold">
                    <T>Desktop plugins</T>
                  </h2>
                  <button
                    type="button"
                    disabled={desktop.pending !== null}
                    onClick={() => void reloadDesktopPlugins()}
                  >
                    <T>Refresh</T>
                  </button>
                </div>
                {desktop.error ? (
                  <p role="alert" className="mt-2 text-destructive">
                    {desktop.error}
                  </p>
                ) : null}
                {desktop.snapshot?.plugins.map((plugin) => (
                  <div
                    key={plugin.manifest.id}
                    className="flex items-center justify-between gap-4 border-b border-border py-3"
                  >
                    <div>
                      <p>{plugin.manifest.name}</p>
                      <p className="text-xs text-muted-foreground">{plugin.manifest.id}</p>
                    </div>
                    <button
                      type="button"
                      disabled={desktop.pending !== null}
                      className="rounded border border-border px-3 py-1 disabled:opacity-50"
                      onClick={() =>
                        void setDesktopPluginEnabled(plugin.manifest.id, !plugin.enabled)
                      }
                    >
                      {desktop.pending === plugin.manifest.id ? (
                        <T>Updating...</T>
                      ) : plugin.enabled ? (
                        <T>Disable</T>
                      ) : (
                        <T>Enable</T>
                      )}
                    </button>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        </div>
      )}
    </PluginRecoveryContext>
  );
}
