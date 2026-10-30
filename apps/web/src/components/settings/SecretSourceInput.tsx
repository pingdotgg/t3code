import {
  SecretReference,
  type EnvironmentId,
  type SecretProviderConfig,
  type SecretProviderId,
  type SecretProviderKind,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KeyRoundIcon, TypeIcon } from "lucide-react";
import { useState, type ComponentProps, type ComponentType, type ReactNode } from "react";

import { isSecretsFeatureEnabled } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { OnePasswordIcon } from "../Icons";
import { serverEnvironment } from "../../state/server";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { classifySecretProvider } from "./SecretProviderDialog.logic";

export interface SecretSource {
  readonly id: SecretProviderId;
  readonly kind: SecretProviderKind;
  readonly label: string;
}

const NO_SECRET_SOURCES: ReadonlyArray<SecretSource> = [];
const STORED_VALUE = "__stored__";
const decodeSecretReference = Schema.decodeUnknownOption(SecretReference);

/** Secret providers a setting can point at; empty when the environment cannot read references. */
export function useSecretSources(environmentId: EnvironmentId): ReadonlyArray<SecretSource> {
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.secretReferences === true,
  );
  if (!isSecretsFeatureEnabled || !supported) return NO_SECRET_SOURCES;
  return (Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>)
    .filter(([, config]) => classifySecretProvider(config).kind !== "unsupported")
    .map(([id, config]) => ({ id, kind: config.kind, label: config.label }));
}

function SourceLabel(props: {
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <props.icon className="size-3.5 shrink-0" />
      <span className="truncate">{props.label}</span>
    </span>
  );
}

type SecretSourceInputProps = Omit<ComponentProps<typeof SecretInput>, "value" | "children"> & {
  readonly value: string | SecretReference;
  readonly sources: ReadonlyArray<SecretSource>;
  readonly onSecretChange: (secret: SecretReference | undefined) => void;
  /** Places the parts in the caller's layout; `source` is null when there is nothing to pick. */
  readonly children?: (parts: {
    readonly source: ReactNode;
    readonly value: ReactNode;
  }) => ReactNode;
};

/** A secret entered here, or read from a secret provider when one is configured. */
export function SecretSourceInput({
  value,
  sources,
  onSecretChange,
  children,
  ...rest
}: SecretSourceInputProps) {
  // A provider picked here applies once a reference for it is committed.
  const [pendingProvider, setPendingProvider] = useState<SecretProviderId | null>(null);
  const [rejectedReference, setRejectedReference] = useState<string | null>(null);
  const secret = typeof value === "string" ? undefined : value;
  const input = { ...rest, value: typeof value === "string" ? value : "" };
  const provider = pendingProvider ?? secret?.provider ?? null;
  const reference = secret !== undefined && secret.provider === provider ? secret.reference : "";
  const providerSource = sources.find((source) => source.id === provider);
  const definition = providerSource && builtInSecretProviderDefinitions.find(providerSource.kind);
  const label = input["aria-label"] ?? "Secret";
  const providerLabel = (id: SecretProviderId) =>
    sources.find((source) => source.id === id)?.label ?? id;
  const providerIcon = (id: SecretProviderId) =>
    sources.some((source) => source.id === id) ? OnePasswordIcon : KeyRoundIcon;

  const source =
    sources.length === 0 && provider === null ? null : (
      <Select
        value={provider ?? STORED_VALUE}
        onValueChange={(value) => {
          setRejectedReference(null);
          if (value === STORED_VALUE || value === null) {
            setPendingProvider(null);
            if (secret !== undefined) onSecretChange(undefined);
            return;
          }
          const next = value as SecretProviderId;
          setPendingProvider(next === secret?.provider ? null : next);
        }}
      >
        <SelectTrigger size="sm" className="w-full min-w-0" aria-label={`${label} source`}>
          <SelectValue>
            {provider === null ? (
              <SourceLabel icon={TypeIcon} label="Value" />
            ) : (
              <SourceLabel icon={providerIcon(provider)} label={providerLabel(provider)} />
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          <SelectItem value={STORED_VALUE}>
            <SourceLabel icon={TypeIcon} label="Value" />
          </SelectItem>
          {sources.map((source) => (
            <SelectItem key={source.id} value={source.id}>
              <SourceLabel icon={OnePasswordIcon} label={source.label} />
            </SelectItem>
          ))}
          {provider !== null && !sources.some((source) => source.id === provider) ? (
            <SelectItem value={provider}>
              <SourceLabel icon={KeyRoundIcon} label={provider} />
            </SelectItem>
          ) : null}
        </SelectPopup>
      </Select>
    );

  const valueField =
    provider === null ? (
      <SecretInput {...input} />
    ) : (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <DraftInput
          {...(input.id !== undefined ? { id: input.id } : {})}
          size="sm"
          font="mono"
          value={rejectedReference ?? reference}
          onCommit={(next) => {
            if (next.trim().length === 0) {
              setRejectedReference(null);
              if (pendingProvider === null && secret !== undefined) onSecretChange(undefined);
              return;
            }
            const decoded = decodeSecretReference({ provider, reference: next });
            if (
              Option.isNone(decoded) ||
              definition?.isReference(decoded.value.reference) === false
            ) {
              setRejectedReference(next);
              return;
            }
            setRejectedReference(null);
            setPendingProvider(null);
            onSecretChange(decoded.value);
          }}
          autoComplete="off"
          placeholder={definition?.referencePlaceholder}
          spellCheck={false}
          aria-label={`${label} reference`}
          aria-invalid={rejectedReference !== null}
        />
        {rejectedReference !== null ? (
          <p className="text-2xs text-destructive">
            {definition?.invalidReferenceMessage ?? "Enter a valid secret reference."}
          </p>
        ) : null}
      </div>
    );

  if (children !== undefined) return children({ source, value: valueField });
  if (source === null) return valueField;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5">
      <div className="w-28 shrink-0">{source}</div>
      {valueField}
    </div>
  );
}
