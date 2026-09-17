import type { EnvironmentId, ProviderSkillKey, ServerProvider } from "@t3tools/contracts";
import { SearchIcon, XIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Switch } from "../ui/switch";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildSkillsSettingsModel,
  isSameProviderSkillKey,
  toggleDisabledSkill,
  type SkillsSettingsInputProvider,
} from "./skillsSettings.logic";

function providerLabel(provider: ServerProvider): string {
  return (
    provider.displayName ?? DRIVER_OPTION_BY_VALUE[provider.driver]?.label ?? provider.instanceId
  );
}

/**
 * Every skill a provider on this environment discovered, in one list. A
 * workspace snapshot holds the skills of one checkout, so the rows are the
 * union across snapshots: a Repo skill stays listed while another project is
 * open.
 */
function toSkillsInputProviders(
  providers: ReadonlyArray<ServerProvider>,
): SkillsSettingsInputProvider[] {
  return providers.map((provider) => ({
    id: provider.instanceId,
    label: providerLabel(provider),
    skills: [
      ...provider.skills,
      ...(provider.workspaceSnapshots ?? []).flatMap((snapshot) => snapshot.skills),
    ],
  }));
}

/**
 * The environment's skill list. Switching a skill off writes its key to
 * `disabledSkills`; the registry republishes its fold, so the composer picker
 * follows without a reload.
 */
export function SkillsSettings({
  environmentId,
  providers,
  disabledSkills,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly disabledSkills: ReadonlyArray<ProviderSkillKey>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [query, setQuery] = useState("");
  const inputProviders = useMemo(() => toSkillsInputProviders(providers), [providers]);
  const model = useMemo(
    () => buildSkillsSettingsModel({ providers: inputProviders, disabledSkills, query }),
    [inputProviders, disabledSkills, query],
  );

  const setDisabled = (key: ProviderSkillKey, disabled: boolean) => {
    updateSettings({ disabledSkills: toggleDisabledSkill(disabledSkills, key, disabled) });
  };

  const isEmpty = model.providers.length === 0 && model.stale.length === 0;

  return (
    <SettingsSection {...searchableSetting("skills")}>
      <div className="px-3 py-2 sm:px-4">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search skills"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search skills..."
            type="search"
            value={query}
          />
        </InputGroup>
      </div>

      {isEmpty ? (
        <SettingsRow
          title={model.hasHiddenRows ? "No skills match this search." : "No skills discovered."}
          description={
            model.hasHiddenRows
              ? undefined
              : "Providers report their skills when they start a thread or refresh."
          }
        />
      ) : null}

      {model.providers.map((provider) =>
        provider.sources.map((source) => (
          <Fragment key={`${provider.id}:${source.source}`}>
            <div className="px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
              {provider.label} · {source.label}
            </div>
            {source.rows.map((row) => (
              <SettingsRow
                key={row.id}
                title={row.title}
                description={
                  <span className="break-all">
                    {row.description ? `${row.description} · ` : null}
                    {row.path}
                  </span>
                }
                control={
                  <div className="flex shrink-0 items-center gap-2">
                    {row.disabledByProvider ? (
                      <span className="text-xs text-muted-foreground">Disabled by provider</span>
                    ) : null}
                    <Switch
                      aria-label={`Enable ${row.title}`}
                      checked={!row.disabled}
                      disabled={readOnly || row.disabledByProvider}
                      onCheckedChange={(enabled) => setDisabled(row.key, !enabled)}
                    />
                  </div>
                }
              />
            ))}
          </Fragment>
        )),
      )}

      {model.stale.length > 0 ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
          Stale · switched off, nothing discovered
        </div>
      ) : null}
      {model.stale.map((row) => (
        <SettingsRow
          key={row.id}
          title={row.label}
          description="No provider on this environment reports this skill."
          control={
            !readOnly ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${row.label}`}
                onClick={() =>
                  updateSettings({
                    disabledSkills: disabledSkills.filter(
                      (key) => !isSameProviderSkillKey(key, row.key),
                    ),
                  })
                }
              >
                <XIcon />
              </Button>
            ) : null
          }
        />
      ))}

      <p className="px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        Switching a skill off hides it from the composer picker and sends a typed <code>$name</code>{" "}
        as plain text. T3 Code never writes a provider's own configuration, so the agent may still
        start the skill on its own when it finds it on disk.
      </p>
    </SettingsSection>
  );
}
