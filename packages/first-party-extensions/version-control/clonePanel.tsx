import {
  projectsCloneApi,
  sourceControlDiscoveryApi,
  type CloneProtocol,
  type CloneReceipt,
  type CloneRepository,
  type ProjectClones,
  type SourceControlDiscovery,
  type SourceControlKind,
  type RepositoryList,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useRef, useState } from "react";
import { publishProviderOption, readyPublishProviders } from "./viewModel.js";

const stageLabels = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

export function useSourceControlDiscovery(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
) {
  const [data, setData] = useState<SourceControlDiscovery>({ providers: [] });
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const scanned = useRef<{ host: ClientHost; session: ViewSession; revision: number } | null>(null);
  useEffect(() => {
    if (
      !visible ||
      (scanned.current?.host === host &&
        scanned.current.session === session &&
        scanned.current.revision === revision)
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(sourceControlDiscoveryApi, host, session.context)
      .invoke("discover", {}, signal)
      .then(
        (result) => {
          if (!signal.aborted) {
            scanned.current = { host, session, revision };
            setData(result);
            setError(null);
          }
        },
        (cause) => {
          if (!signal.aborted) {
            scanned.current = { host, session, revision };
            setError(
              cause instanceof Error ? cause.message : "Source control discovery unavailable",
            );
          }
        },
      );
    return () => controller.abort();
  }, [host, session, visible, revision]);
  return {
    ...data,
    error,
    refresh: () => {
      setRevision((value) => value + 1);
    },
  };
}

export function CloneRepositoryPanel({
  host,
  session,
  discovery,
  visible,
}: {
  host: ClientHost;
  session: ViewSession;
  discovery: SourceControlDiscovery;
  visible: boolean;
}) {
  const [selectedSource, setSource] = useState<SourceControlKind | "url">("url");
  const ready = readyPublishProviders(discovery.providers);
  const source =
    selectedSource === "url" || ready.some((provider) => provider.kind === selectedSource)
      ? selectedSource
      : "url";
  const [repositoryInput, setRepositoryInput] = useState("");
  const [prepared, setPrepared] = useState<{
    source: typeof source;
    input: string;
    repository: CloneRepository | null;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [destinationName, setDestinationName] = useState("");
  const [protocol, setProtocol] = useState<CloneProtocol>("auto");
  const [listingCache, setListings] = useState<{
    providers: SourceControlDiscovery["providers"];
    values: Partial<Record<SourceControlKind, RepositoryList>>;
  }>({ providers: discovery.providers, values: {} });
  const listings = listingCache.providers === discovery.providers ? listingCache.values : {};
  const listing = source === "url" ? null : listings[source];
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<CloneReceipt | null>(null);
  const [clones, setClones] = useState<ProjectClones>({ clones: [], truncated: false });
  const guard = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const preparedRepository =
    prepared?.source === source && prepared.input === repositoryInput ? prepared : null;

  useEffect(() => {
    if (
      !visible ||
      source === "url" ||
      (listingCache.providers === discovery.providers && listingCache.values[source])
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(sourceControlDiscoveryApi, host, session.context)
      .invoke("listRepositories", { provider: source }, signal)
      .then(
        (result) => {
          if (!signal.aborted)
            setListings((current) => ({
              providers: discovery.providers,
              values: {
                ...(current.providers === discovery.providers ? current.values : {}),
                [source]: result,
              },
            }));
        },
        (cause) => {
          if (!signal.aborted)
            setError(cause instanceof Error ? cause.message : "Repository list unavailable");
        },
      );
    return () => controller.abort();
  }, [host, session, source, visible, discovery.providers, listingCache]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void (async () => {
      try {
        for await (const event of bindStreamApi(projectsCloneApi, host, session.context).subscribe(
          "subscribe",
          {},
          signal,
        )) {
          if (signal.aborted) return;
          if (event.type === "snapshot" || event.type === "data") setClones(event.value);
        }
      } catch (cause) {
        if (!signal.aborted)
          setError(cause instanceof Error ? cause.message : "Clone progress unavailable");
      }
    })();
    return () => controller.abort();
  }, [host, session, visible]);

  const run = (operation: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    setPending(true);
    setError(null);
    void operation()
      .catch((cause) => {
        if (mounted.current && !session.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Clone unavailable");
      })
      .finally(() => {
        guard.current = false;
        if (mounted.current && !session.signal.aborted) setPending(false);
      });
  };
  const next = () =>
    run(async () => {
      const input = repositoryInput.trim();
      const repository =
        source === "url"
          ? null
          : await bindApi(sourceControlDiscoveryApi, host, session.context).invoke(
              "lookupRepository",
              { provider: source, repository: input },
              session.signal,
            );
      if (!mounted.current || session.signal.aborted) return;
      const name =
        (repository?.nameWithOwner ?? input)
          .split(/[/:]/)
          .findLast((segment) => segment.length > 0)
          ?.replace(/\.git$/, "") ?? "repository";
      setTitle(name);
      setDestinationName(name);
      setPrepared({ source, input: repositoryInput, repository });
    });
  const start = () =>
    run(async () => {
      if (!preparedRepository) return;
      const result = await bindApi(projectsCloneApi, host, session.context).invoke(
        "start",
        {
          title,
          destinationName,
          protocol,
          ...(source === "url"
            ? { remoteUrl: repositoryInput.trim() }
            : {
                provider: source,
                repository: preparedRepository.input.trim(),
              }),
        },
        session.signal,
      );
      if (mounted.current && !session.signal.aborted) setReceipt(result);
    });
  const action = (method: "cancel" | "retry", projectId: string) =>
    run(async () => {
      const result = await bindApi(projectsCloneApi, host, session.context).invoke(
        method,
        { projectId },
        session.signal,
      );
      if (!result.applied) throw new Error("Clone is no longer available for this action.");
    });
  const control = {
    background: "var(--background, #fff)",
    color: "inherit",
    border: "1px solid var(--border, #dfe3e8)",
    borderRadius: 4,
    padding: "4px 6px",
    fontSize: 12,
  };
  return (
    <section
      aria-label="Clone repository"
      style={{
        display: "grid",
        gap: 8,
        padding: 8,
        borderBottom: "1px solid var(--border, #dfe3e8)",
        fontSize: 12,
      }}
    >
      <label>
        Source{" "}
        <select
          aria-label="Clone source"
          value={source}
          disabled={pending}
          onChange={(event) => {
            setSource(event.target.value as typeof source);
            setPrepared(null);
            setError(null);
          }}
          style={control}
        >
          <option value="url">Git URL</option>
          {discovery.providers
            .filter((provider) => provider.kind !== "unknown")
            .map((provider) => (
              <option key={provider.kind} value={provider.kind} disabled={!provider.ready}>
                {provider.label}
                {provider.ready ? "" : ` — ${provider.hint ?? "Unavailable"}`}
              </option>
            ))}
        </select>
      </label>
      {source !== "url" && listing && (
        <label>
          Your repositories{" "}
          <select
            aria-label="Your repositories"
            value=""
            disabled={pending}
            onChange={(event) => {
              setRepositoryInput(event.target.value);
              setPrepared(null);
            }}
            style={control}
          >
            <option value="">Select a repository…</option>
            {listing.repositories.map((repository) => (
              <option key={repository.nameWithOwner} value={repository.nameWithOwner}>
                {repository.nameWithOwner}
              </option>
            ))}
          </select>
          {listing.truncated && (
            <span>Recent repositories only; enter another repository below.</span>
          )}
        </label>
      )}
      <label>
        {source === "url" ? "Git URL" : "Repository"}
        <input
          aria-label="Clone repository input"
          value={repositoryInput}
          disabled={pending}
          onChange={(event) => {
            setRepositoryInput(event.target.value);
            setPrepared(null);
          }}
          placeholder={
            source === "url"
              ? "https://host/owner/repository.git"
              : publishProviderOption(source).pathPlaceholder
          }
          style={control}
        />
      </label>
      {preparedRepository === null ? (
        <button
          type="button"
          disabled={pending || repositoryInput.trim() === ""}
          onClick={next}
          style={control}
        >
          Next
        </button>
      ) : (
        <>
          <label>
            Project name{" "}
            <input
              aria-label="Clone project name"
              value={title}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
              style={control}
            />
          </label>
          <label>
            Directory name{" "}
            <input
              aria-label="Clone directory name"
              value={destinationName}
              disabled={pending}
              onChange={(event) => setDestinationName(event.target.value)}
              style={control}
            />
          </label>
          <span>The environment clones into its managed projects folder.</span>
          <label>
            Protocol{" "}
            <select
              aria-label="Clone protocol"
              value={protocol}
              disabled={pending}
              onChange={(event) => setProtocol(event.target.value as CloneProtocol)}
              style={control}
            >
              <option value="auto">Automatic</option>
              <option value="ssh">SSH</option>
              <option value="https">HTTPS</option>
            </select>
          </label>
          <div>
            <button
              type="button"
              disabled={pending}
              onClick={() => setPrepared(null)}
              style={control}
            >
              Back
            </button>{" "}
            <button
              type="button"
              disabled={
                pending ||
                title.trim() === "" ||
                !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(destinationName) ||
                destinationName.length > 128
              }
              onClick={start}
              style={control}
            >
              Clone repository
            </button>
          </div>
        </>
      )}
      {pending && <span role="status">Working…</span>}
      {error && <span role="alert">{error}</span>}
      {receipt && <span role="status">Project added: {receipt.cwd}</span>}
      {clones.clones.map((clone) => (
        <div key={clone.projectId}>
          <span>
            {clone.repository?.nameWithOwner ?? clone.destinationPath.split(/[/\\]/).at(-1)} ·{" "}
            {clone.phase === "running"
              ? `${stageLabels[clone.stage]}${clone.percent === null ? "" : ` · ${clone.percent}%`}${clone.detail ? ` · ${clone.detail}` : ""}`
              : clone.phase}
          </span>
          {clone.error && <span role="alert">{clone.error}</span>}
          {clone.phase === "running" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => action("cancel", clone.projectId)}
              style={control}
            >
              Cancel clone
            </button>
          )}
          {(clone.phase === "failed" || clone.phase === "cancelled") && (
            <button
              type="button"
              disabled={pending}
              onClick={() => action("retry", clone.projectId)}
              style={control}
            >
              Retry clone
            </button>
          )}
        </div>
      ))}
      {clones.truncated && <span>More clones are active in this environment.</span>}
    </section>
  );
}
