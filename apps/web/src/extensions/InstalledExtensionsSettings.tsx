import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  EXTENSION_GRANT_CAPABILITIES_MAX,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  API_CALL_TIME_GRANTS,
  GENERIC_API_CATALOGUE,
  HOST_CAPABILITY_GRANTS,
  HOST_CAPABILITY_GRANT_DESCRIPTIONS,
} from "@t3tools/extension-sdk/catalogue";
import { WORKSPACE_READ_TEXT } from "@t3tools/extension-sdk/workspace";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { useEnvironments } from "../state/environments";
import { useEnvironmentSessionState, usePreparedConnection } from "../state/session";
import { environmentProjects } from "../state/projects";
import {
  installEnvironmentExtension,
  selectInstalledApiProvider,
  manageInstalledExtension,
  refreshInstalledExtensions,
  useInstalledExtensions,
} from "./installedEnvironment";
import type { InstalledPackage } from "./installedController";

interface Grants {
  readonly capabilities: readonly string[];
  readonly projectIds: readonly ProjectId[];
}
interface Project {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}
const NO_GRANTS: Grants = { capabilities: [], projectIds: [] };
const operationsOf = (api: (typeof GENERIC_API_CATALOGUE)[number]) => [
  ...(api.methods ?? []),
  ...(api.streams ?? []),
];
/** Every grant a catalogue API checks, plus host-checked grants; read-text has its own choice. */
const GRANT_CHOICES = [
  ...new Set([
    ...GENERIC_API_CATALOGUE.flatMap((api) =>
      operationsOf(api).flatMap((operation) => operation.requiredGrants),
    ),
    ...HOST_CAPABILITY_GRANTS,
    ...Object.values(API_CALL_TIME_GRANTS).flat(),
  ]),
].filter((grant) => grant !== WORKSPACE_READ_TEXT);

/** What a grant allows: the catalogue API calls that check it, or null when this client cannot tell. */
function grantUses(grant: string): string | null {
  if (HOST_CAPABILITY_GRANT_DESCRIPTIONS[grant]) return HOST_CAPABILITY_GRANT_DESCRIPTIONS[grant];
  if (HOST_CAPABILITY_GRANTS.includes(grant)) return "Host service " + grant;
  const uses = GENERIC_API_CATALOGUE.flatMap((api) => {
    const names = operationsOf(api)
      .filter((operation) => operation.requiredGrants.includes(grant))
      .map((operation) => operation.name);
    return names.length ? [api.id + ": " + names.join(", ")] : [];
  });
  // The catalogue can list one API at several versions.
  if (uses.length) return "Allows " + [...new Set(uses)].join("; ");
  const checkedBy = Object.keys(API_CALL_TIME_GRANTS).filter((api) =>
    API_CALL_TIME_GRANTS[api]!.includes(grant),
  );
  return checkedBy.length ? "Checked by " + checkedBy.join(", ") + " when it is called" : null;
}

/** The server rejects a grant set over the cap, so no action here may submit one. */
const overCap = (grants: Grants) => grants.capabilities.length > EXTENSION_GRANT_CAPABILITIES_MAX;

const toggled = <T,>(list: readonly T[], item: T, on: boolean) =>
  on ? (list.includes(item) ? list : [...list, item]) : list.filter((value) => value !== item);

/** Project and grant checkboxes over one grant set; held grants outside the catalogue stay listed. */
function PermissionChoices(props: {
  projects: readonly Project[];
  value: Grants;
  onChange: (update: (current: Grants) => Grants) => void;
  legend: string;
}) {
  const { projects, value, onChange } = props;
  const choices = [
    ...GRANT_CHOICES,
    ...value.capabilities.filter(
      (grant) => grant !== WORKSPACE_READ_TEXT && !GRANT_CHOICES.includes(grant),
    ),
  ];
  const setGrant = (grant: string, on: boolean) =>
    onChange((current) => ({ ...current, capabilities: toggled(current.capabilities, grant, on) }));
  return (
    <>
      {overCap(value) ? (
        <p role="status" className="text-sm text-destructive">
          {`An installation can hold at most ${EXTENSION_GRANT_CAPABILITIES_MAX} permissions; ${value.capabilities.length} are selected.`}
        </p>
      ) : null}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{props.legend}</legend>
        {projects.map((project) => (
          <label key={project.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.projectIds.includes(project.id)}
              onCheckedChange={(checked) =>
                onChange((current) => ({
                  ...current,
                  projectIds: toggled(current.projectIds, project.id, checked === true),
                }))
              }
            />
            {project.title} · {project.workspaceRoot}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={value.capabilities.includes(WORKSPACE_READ_TEXT)}
          onCheckedChange={(checked) => setGrant(WORKSPACE_READ_TEXT, checked === true)}
        />
        Allow workspace text reads in selected projects
      </label>
      {choices.map((grant) => (
        <label key={grant} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.capabilities.includes(grant)}
            onCheckedChange={(checked) => setGrant(grant, checked === true)}
          />
          {grant === "t3.projects/create" || grant === "t3.source-control/read"
            ? grantUses(grant)
            : `Allow ${grant} in selected projects`}
        </label>
      ))}
    </>
  );
}

function GrantList({ grants }: { grants: readonly string[] }) {
  return (
    <ul className="text-sm">
      {grants.map((grant) => (
        <li key={grant}>
          {grant}
          {grantUses(grant) ? (
            <span className="text-muted-foreground"> — {grantUses(grant)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export const PERMISSION_SUGGESTION_NOTE =
  "Suggested from the APIs it declares. Some may go unused, and some features can still ask for more; add those with Edit permissions.";

/**
 * An installation's permissions. Only explicit clicks here add grants: the
 * editor starts from the current set so applying it never silently revokes,
 * and "Grant new permissions" adds exactly the missing required grants.
 */
function InstallationPermissions(props: {
  environmentId: EnvironmentId;
  item: InstalledPackage;
  projects: readonly Project[];
  disabled: boolean;
  act: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { environmentId, item, projects, disabled, act } = props;
  const current = item.grants;
  // Older servers do not report requiredGrants; then nothing is offered.
  const missing = (item.requiredGrants ?? []).filter(
    (grant) => !current.capabilities.includes(grant),
  );
  const [draft, setDraft] = useState<Grants | null>(null);
  const apply = (grants: Grants) =>
    act(() => manageInstalledExtension(environmentId, { id: item.id, action: "grants", grants }));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Permissions</p>
      {current.capabilities.length ? (
        <GrantList grants={current.capabilities} />
      ) : (
        <p className="text-sm text-muted-foreground">No permissions granted.</p>
      )}
      {missing.length ? (
        <>
          <p role="status" className="text-sm">
            This version can use {missing.length} permission{missing.length === 1 ? "" : "s"} it
            does not have:
          </p>
          <GrantList grants={missing} />
          <p className="text-sm text-muted-foreground">{PERMISSION_SUGGESTION_NOTE}</p>
          {current.capabilities.length + missing.length > EXTENSION_GRANT_CAPABILITIES_MAX ? (
            <p role="status" className="text-sm">
              {`An installation can hold at most ${EXTENSION_GRANT_CAPABILITIES_MAX} permissions and this one has ${current.capabilities.length}. Use Edit permissions to remove ones it does not need, then grant these.`}
            </p>
          ) : (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                // Additive on the server, so a grant another client just changed is never undone.
                void act(() =>
                  manageInstalledExtension(environmentId, {
                    id: item.id,
                    action: "addGrants",
                    grants: { capabilities: missing, projectIds: [] },
                  }),
                )
              }
            >
              Grant {missing.length} new permission{missing.length === 1 ? "" : "s"}
            </Button>
          )}
        </>
      ) : null}
      {draft ? (
        <div className="space-y-2">
          <PermissionChoices
            projects={projects}
            value={draft}
            onChange={(update) => setDraft((open) => open && update(open))}
            legend="Allowed projects"
          />
          <p className="text-sm text-muted-foreground">
            Apply replaces this installation's permissions and allowed projects with the selection.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={disabled || overCap(draft)}
              onClick={() => void apply(draft).then((applied) => applied && setDraft(null))}
            >
              Apply selected permissions
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={() => setDraft(current)}>
          Edit permissions
        </Button>
      )}
    </div>
  );
}

function EnvironmentPackages({ environmentId }: { environmentId: EnvironmentId }) {
  const snapshot = useInstalledExtensions(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const connected = usePreparedConnection(environmentId)._tag === "Some";
  const canManage =
    session.data?.authenticated === true &&
    session.data.scopes?.includes(AuthAccessWriteScope) === true;
  const canChange = canManage && connected;
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [path, setPath] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [grants, setGrants] = useState<Grants>(NO_GRANTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setTrusted(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extension operation failed");
      return false;
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
      <PermissionChoices
        projects={projects}
        value={grants}
        onChange={setGrants}
        legend="Allowed projects for installation"
      />
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={trusted} onCheckedChange={(checked) => setTrusted(checked === true)} />I
        trust this package to run code in this environment and client
      </label>
      <p className="text-sm text-muted-foreground">
        These permissions apply to a new installation. Updates and rollback keep an installation's
        existing permissions; new ones are added only from its permissions below.
      </p>
      <div className="flex gap-2">
        <Button
          disabled={!canChange || busy || !trusted || !path.trim() || overCap(grants)}
          onClick={() =>
            void act(() =>
              installEnvironmentExtension(environmentId, {
                sourceDir: path,
                ...grants,
                trusted: true,
              }),
            )
          }
        >
          Install package
        </Button>
        <Button
          variant="outline"
          disabled={!connected || busy || snapshot.loading}
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
      {!connected && snapshot.installations.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          Disconnected. Showing the last known installations.
        </p>
      ) : null}
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
          <InstallationPermissions
            // A grant change elsewhere discards an open edit rather than applying over it.
            key={JSON.stringify(item.grants)}
            environmentId={environmentId}
            item={item}
            projects={projects}
            disabled={!canChange || busy}
            act={act}
          />
          {item.package.format !== 1
            ? item.package.provides.map((api) => (
                <Button
                  key={api.id}
                  variant="outline"
                  disabled={!canChange || busy || !item.enabled}
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
              disabled={!canChange || busy}
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
              disabled={!canChange || busy}
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
              disabled={!canChange || busy || !trusted || !path.trim()}
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
              disabled={!canChange || busy}
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
