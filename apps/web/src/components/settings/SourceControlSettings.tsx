import { Option } from "effect";
import { IconArrowClockwise as RefreshIcon } from "symbols-react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SourceControlProviderDiscoveryItem, VcsDiscoveryItem } from "@forma/contracts";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { sourceControlDiscoveryQueryOptions } from "../../lib/gitReactQuery";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function optionText(value: Option.Option<string>): string | null {
  return Option.isSome(value) ? value.value : null;
}

function StatusBadge({ status }: { status: "available" | "missing" }): ReactNode {
  return (
    <span
      className={
        status === "available"
          ? "rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
          : "rounded-full bg-destructive/12 px-2 py-0.5 text-xs font-medium text-destructive"
      }
    >
      {status === "available" ? "Available" : "Missing"}
    </span>
  );
}

function VcsRow({ item }: { item: VcsDiscoveryItem }) {
  const detail = optionText(item.detail);
  const version = optionText(item.version);
  return (
    <SettingsRow
      title={item.label}
      description={detail ?? item.installHint}
      status={version}
      control={<StatusBadge status={item.status} />}
    />
  );
}

function ProviderRow({ item }: { item: SourceControlProviderDiscoveryItem }) {
  const detail = optionText(item.detail) ?? optionText(item.auth.detail);
  const account = optionText(item.auth.account);
  const host = optionText(item.auth.host);
  const version = optionText(item.version);
  const authLabel =
    item.status === "missing"
      ? "Unavailable"
      : item.auth.status === "authenticated"
        ? account
          ? `Authenticated as ${account}${host ? ` on ${host}` : ""}`
          : "Authenticated"
        : item.auth.status === "unauthenticated"
          ? "Authentication required"
          : "Auth status unknown";

  return (
    <SettingsRow
      title={item.label}
      description={detail ?? item.installHint}
      status={[version, authLabel].filter(Boolean).join(" · ")}
      control={<StatusBadge status={item.status} />}
    />
  );
}

export function SourceControlSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const discoveryQuery = useQuery(
    sourceControlDiscoveryQueryOptions({ environmentId: primaryEnvironmentId }),
  );
  const discovery = discoveryQuery.data;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Source Control"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={discoveryQuery.isFetching}
            onClick={() => void discoveryQuery.refetch()}
          >
            <RefreshIcon className="size-3.5 fill-current" />
            Refresh
          </Button>
        }
      >
        {discovery?.versionControlSystems.map((item) => (
          <VcsRow key={item.kind} item={item} />
        ))}
        {discovery === undefined && !discoveryQuery.isError ? (
          <SettingsRow
            title="Checking tools"
            description="Looking for Git, GitHub CLI, and GitLab CLI."
          />
        ) : null}
        {discoveryQuery.isError ? (
          <SettingsRow
            title="Discovery failed"
            description={
              discoveryQuery.error instanceof Error
                ? discoveryQuery.error.message
                : "Unable to discover source control tools."
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Hosting Providers">
        {discovery?.sourceControlProviders.map((item) => (
          <ProviderRow key={item.kind} item={item} />
        ))}
        {discovery === undefined && !discoveryQuery.isError ? (
          <SettingsRow title="Checking providers" description="Checking GitHub and GitLab auth." />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
