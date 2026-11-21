import type { EnvironmentId, SourceControlProviderAuth } from "@t3tools/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, Var } from "gt-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { groupHostAccounts, nextHostAccountChoices } from "./SourceControlAccountSettings.logic";
import {
  readHostCredentialSettings,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
} from "@t3tools/client-runtime/source-control-clients";
import { redactedPlaceholder } from "./RedactedSensitiveText";

/** Sentinel select value for "follow the CLI's active login"; logins never contain spaces. */
const ACTIVE_ACCOUNT = "active cli account";

function RedactedLogin(props: {
  readonly account: string;
  readonly revealed: boolean;
  readonly label?: string;
}) {
  const gt = useGT();
  return props.revealed ? (
    <span className="min-w-0 truncate font-mono text-2xs">{props.account}</span>
  ) : (
    <span className="min-w-0 truncate font-mono text-2xs">
      <span className="select-none blur-xs" aria-hidden>
        {redactedPlaceholder(props.account)}
      </span>
      <span className="sr-only">{props.label ?? gt("Hidden account")}</span>
    </span>
  );
}

export function SourceControlAccountSettings({
  environmentId,
  definition,
  credentials,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly credentials: SourceControlHostCredentials;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const gt = useGT();
  const { hosts } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const { label } = definition;
  const { cliName } = credentials;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${label} account settings`,
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const groups = groupHostAccounts(auth.accounts ?? []);

  const save = async (
    host: string,
    change: { readonly enabled?: boolean; readonly account?: string | null },
  ) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          sourceControlHosts: {
            [definition.kind]: { hosts: nextHostAccountChoices(hosts, host, change) },
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>
          Sign in with{" "}
          <code dir="ltr" className="rounded bg-muted px-1 py-px text-2xs">
            <Var>{credentials.loginCommand}</Var>
          </code>{" "}
          on the server host, then rescan to choose accounts here.
        </T>
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          <T>
            Choose which{" "}
            <code dir="ltr" className="rounded bg-muted px-1 py-px text-2xs">
              <Var>{cliName}</Var>
            </code>{" "}
            login each <Var>{label}</Var> host uses, or turn a host off.
          </T>
        </p>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setRevealed((current) => !current)}
          aria-label={
            revealed
              ? gt("Hide {label} accounts", { label })
              : gt("Reveal {label} accounts", { label })
          }
          aria-pressed={revealed}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      {groups.map((group) => {
        const choice = hosts[group.host];
        const enabled = choice?.enabled ?? true;
        const stalePin =
          choice?.account !== undefined && !group.selectable.includes(choice.account);
        const pinned = choice?.account !== undefined && !stalePin ? choice.account : ACTIVE_ACCOUNT;
        return (
          <div key={group.host} className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <span className="text-xs font-medium text-foreground">{group.host}</span>
                {group.selectable.length === 1 && group.selectable[0] !== undefined ? (
                  <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span>
                      <T>Signed in as</T>
                    </span>
                    <RedactedLogin revealed={revealed} account={group.selectable[0]} />
                  </p>
                ) : null}
              </div>
              <Switch
                checked={enabled}
                disabled={saving}
                aria-label={gt("Use {label} on {host}", { label, host: group.host })}
                onCheckedChange={(checked) => void save(group.host, { enabled: checked })}
              />
            </div>
            {group.selectable.length > 1 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  <T>Account</T>
                </span>
                <div className="w-64 max-w-full">
                  <Select
                    value={pinned}
                    disabled={saving || !enabled}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      void save(group.host, {
                        account: value === ACTIVE_ACCOUNT ? null : value,
                      });
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={gt("{label} account for {host}", { label, host: group.host })}
                    >
                      <SelectValue>
                        {(value: string) =>
                          value === ACTIVE_ACCOUNT ? (
                            <span className="flex min-w-0 items-center gap-1">
                              {group.activeAccount ? (
                                <T>
                                  Active <Var>{cliName}</Var> account (
                                  <RedactedLogin
                                    revealed={revealed}
                                    account={group.activeAccount}
                                  />
                                  )
                                </T>
                              ) : (
                                <T>
                                  Active <Var>{cliName}</Var> account
                                </T>
                              )}
                            </span>
                          ) : (
                            <RedactedLogin revealed={revealed} account={value} />
                          )
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value={ACTIVE_ACCOUNT}>
                        <span className="flex min-w-0 items-center gap-1">
                          {group.activeAccount ? (
                            <T>
                              Active <Var>{cliName}</Var> account (
                              <RedactedLogin revealed={revealed} account={group.activeAccount} />)
                            </T>
                          ) : (
                            <T>
                              Active <Var>{cliName}</Var> account
                            </T>
                          )}
                        </span>
                      </SelectItem>
                      {group.selectable.map((account, index) => (
                        <SelectItem key={account} value={account}>
                          <RedactedLogin
                            revealed={revealed}
                            account={account}
                            label={gt("Account {number}", { number: index + 1 })}
                          />
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null}
            {stalePin ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-warning">
                  <T>
                    The chosen login is no longer signed in, so the active <Var>{cliName}</Var>{" "}
                    login is used.
                  </T>
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save(group.host, { account: null })}
                >
                  <T>Use active login</T>
                </Button>
              </div>
            ) : null}
            {group.broken.map((entry) => (
              <p
                key={entry.account}
                className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground/70"
              >
                {entry.error ? (
                  <T>
                    <RedactedLogin revealed={revealed} account={entry.account} />{" "}
                    <span>
                      can&apos;t be used: <Var>{entry.error}</Var>
                    </span>
                  </T>
                ) : (
                  <T>
                    <RedactedLogin revealed={revealed} account={entry.account} />{" "}
                    <span>
                      can&apos;t be used: <Var>{cliName}</Var> reports this login as invalid.
                    </span>
                  </T>
                )}
              </p>
            ))}
            {group.environmentVariable ? (
              <p className="text-xs text-warning">
                <T>
                  <Var>{group.environmentVariable}</Var> is set on the server, so it overrides the
                  account chosen here until it is unset.
                </T>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
