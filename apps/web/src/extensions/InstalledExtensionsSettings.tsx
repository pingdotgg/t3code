import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { GENERIC_API_CATALOGUE, HOST_CAPABILITY_GRANTS } from "@t3tools/extension-sdk/catalogue";
import { WORKSPACE_READ_TEXT } from "@t3tools/extension-sdk/workspace";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { useEnvironments } from "../state/environments";
import { useEnvironmentSessionState } from "../state/session";
import { environmentProjects } from "../state/projects";
import {
  installEnvironmentExtension,
  selectInstalledApiProvider,
  manageInstalledExtension,
  refreshInstalledExtensions,
  useInstalledExtensions,
} from "./installedEnvironment";

function EnvironmentPackages({ environmentId }: { environmentId: EnvironmentId }) {
  const snapshot = useInstalledExtensions(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const canManage =
    session.data?.authenticated === true &&
    session.data.scopes?.includes(AuthAccessWriteScope) === true;
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [path, setPath] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [readText, setReadText] = useState(false);
  const [apiGrants, setApiGrants] = useState<readonly string[]>([]);
  const [projectIds, setProjectIds] = useState<readonly ProjectId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setTrusted(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extension operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Managing packages requires access-management permission on this environment.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Packages run trusted code in this environment and client. Changes sync automatically on
        supported servers; use Refresh extensions with older servers. The package path is on the
        environment's machine.
      </p>
      <label className="block space-y-1 text-sm">
        Package directory
        <Input
          value={path}
          maxLength={4096}
          onChange={(event) => {
            setPath(event.target.value);
            setTrusted(false);
          }}
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Allowed projects for installation</legend>
        {projects.map((project) => (
          <label key={project.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={projectIds.includes(project.id)}
              onCheckedChange={(checked) =>
                setProjectIds((current) =>
                  checked ? [...current, project.id] : current.filter((id) => id !== project.id),
                )
              }
            />
            {project.title} · {project.workspaceRoot}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={readText} onCheckedChange={(checked) => setReadText(checked === true)} />
        Allow workspace text reads in selected projects
      </label>
      {[
        ...new Set([
          ...GENERIC_API_CATALOGUE.flatMap((api) =>
            [...(api.methods ?? []), ...(api.streams ?? [])].flatMap(
              (operation) => operation.requiredGrants,
            ),
          ),
          ...HOST_CAPABILITY_GRANTS,
        ]),
      ]
        .filter((grant) => grant !== WORKSPACE_READ_TEXT)
        .map((grant) => (
          <label key={grant} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={apiGrants.includes(grant)}
              onCheckedChange={(checked) =>
                setApiGrants((current) =>
                  checked ? [...current, grant] : current.filter((value) => value !== grant),
                )
              }
            />
            Allow {grant} in selected projects
          </label>
        ))}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={trusted} onCheckedChange={(checked) => setTrusted(checked === true)} />I
        trust this package to run code in this environment and client
      </label>
      <p className="text-sm text-muted-foreground">
        The permission form applies to new installations. Apply selected permissions replaces all
        permissions and allowed projects for that package; empty selections revoke all grants.
        Updates and rollback keep existing grants.
      </p>
      <div className="flex gap-2">
        <Button
          disabled={!canManage || busy || !trusted || !path.trim()}
          onClick={() =>
            void act(() =>
              installEnvironmentExtension(environmentId, {
                sourceDir: path,
                projectIds,
                capabilities: [...(readText ? [WORKSPACE_READ_TEXT] : []), ...apiGrants],
                trusted: true,
              }),
            )
          }
        >
          Install package
        </Button>
        <Button
          variant="outline"
          disabled={busy || snapshot.loading}
          onClick={() => void act(() => refreshInstalledExtensions(environmentId))}
        >
          Refresh extensions
        </Button>
      </div>
      {snapshot.loading ? <p role="status">Loading extensions</p> : null}
      {error || snapshot.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? snapshot.error}
        </p>
      ) : null}
      {snapshot.apiResolution
        ?.filter((api) => api.reason)
        .map((api) => (
          <p key={api.id} role="status">
            {api.id}: {api.reason?.detail}
          </p>
        ))}
      {!snapshot.loading && !snapshot.installations.length ? (
        <p className="text-sm text-muted-foreground">No installed extensions.</p>
      ) : null}
      {snapshot.installations.map((item) => (
        <div key={item.id} className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">
            {item.id} · {item.package.manifest.version} · {item.enabled ? "Enabled" : "Disabled"}
          </p>
          {snapshot.pluginResolution?.find((state) => state.id === item.id)?.reason ? (
            <p role="status" className="text-sm text-muted-foreground">
              {snapshot.pluginResolution.find((state) => state.id === item.id)?.reason?.detail}
            </p>
          ) : null}
          {snapshot.apiResolution
            ?.filter(
              (api) => api.providerId === item.id || api.reason?.relatedIds.includes(item.id),
            )
            .map((api) => (
              <p key={api.id} role="status" className="text-sm text-muted-foreground">
                {api.reason?.detail ?? "Selected provider for " + api.id}
              </p>
            ))}
          <p className="text-sm text-muted-foreground">
            {item.grants.projectIds.length} allowed projects. Open compatible views from Extensions
            in a thread.
          </p>
          <ul className="text-sm text-muted-foreground">
            {item.grants.projectIds.map((id) => {
              const project = projects.find((candidate) => candidate.id === id);
              return (
                <li key={id}>
                  {project
                    ? project.title + " · " + project.workspaceRoot
                    : "Unavailable project " + id}
                </li>
              );
            })}
          </ul>
          {item.package.format !== 1
            ? item.package.provides.map((api) => (
                <Button
                  key={api.id}
                  variant="outline"
                  disabled={!canManage || busy || !item.enabled}
                  onClick={() =>
                    void act(() =>
                      selectInstalledApiProvider(environmentId, {
                        id: api.id,
                        providerId: item.id,
                        fallbackProviderIds: [],
                      }),
                    )
                  }
                >
                  Use for {api.id}
                </Button>
              ))
            : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() =>
                void act(() =>
                  manageInstalledExtension(environmentId, {
                    id: item.id,
                    action: "grants",
                    grants: {
                      projectIds,
                      capabilities: [...(readText ? [WORKSPACE_READ_TEXT] : []), ...apiGrants],
                    },
                  }),
                )
              }
            >
              Apply selected permissions
            </Button>
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() =>
                void act(() =>
                  manageInstalledExtension(environmentId, { id: item.id, action: "rollback" }),
                )
              }
            >
              Roll back package
            </Button>
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() =>
                void act(() =>
                  manageInstalledExtension(environmentId, {
                    id: item.id,
                    action: item.enabled ? "disable" : "enable",
                  }),
                )
              }
            >
              {item.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="outline"
              disabled={!canManage || busy || !trusted || !path.trim()}
              onClick={() =>
                void act(() =>
                  manageInstalledExtension(environmentId, {
                    id: item.id,
                    action: "update",
                    sourceDir: path,
                    trusted: true,
                  }),
                )
              }
            >
              Update from package directory
            </Button>
            <Button
              variant="outline"
              disabled={!canManage || busy}
              onClick={() =>
                void act(() =>
                  manageInstalledExtension(environmentId, { id: item.id, action: "remove" }),
                )
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
export function InstalledExtensionsSettings() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const current = environments.find((item) => item.environmentId === selected) ?? environments[0];
  return (
    <div className="space-y-3">
      <Menu>
        <MenuTrigger render={<Button variant="outline" />}>
          {current?.label ?? "No connected environments"}
        </MenuTrigger>
        <MenuPopup>
          {environments.map((item) => (
            <MenuItem key={item.environmentId} onClick={() => setSelected(item.environmentId)}>
              {item.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      {current ? (
        <EnvironmentPackages key={current.environmentId} environmentId={current.environmentId} />
      ) : null}
    </div>
  );
}
