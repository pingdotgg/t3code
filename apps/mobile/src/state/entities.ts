import { useAtomValue } from "@effect/atom-react";
import { PartialThreadLinkMetadataError } from "@t3tools/client-runtime/state/orchestration";
import { deriveReportedModelSelection } from "@t3tools/client-runtime/state/thread-execution";

import { appAtomRegistry } from "./atom-registry";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  allowsPreviewTunnel,
  EnvironmentId,
  ThreadId,
  type ComposerContextRecord,
  type OrchestrationV2ThreadLinkMetadata,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  guessThreadLinkRef,
  hasThreadLinks,
  parseThreadLinkHref,
  threadLinkCandidates,
  threadLinkRefs,
  type ThreadLink,
} from "@t3tools/shared/threadLinks";
import { relabelThreadLinks } from "@t3tools/shared/threadLinksCopy";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";

import { threadChipTargets } from "../lib/enrichedLinkPresentation";
import { resolveProjectChipIcon } from "../lib/projectIcon";
import { projectGlyphImageAtom, projectGlyphKey } from "../native/ProjectChipIconImages";
import { projectFaviconUrlAtom } from "./assets";
import { orchestrationEnvironment } from "./orchestration";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);
const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread:empty"),
);
/** Stands for the localized fallback title, resolved where the link renders. */
const FALLBACK_THREAD_TITLE = Symbol("fallback-thread-title");
type ThreadLinkTitle = string | typeof FALLBACK_THREAD_TITLE;

const EMPTY_THREAD_LINK_TITLES_ATOM = Atom.make<ReadonlyMap<string, ThreadLinkTitle>>(
  new Map(),
).pipe(Atom.withLabel("mobile-thread-link-titles:empty"));

const decodeThreadKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, ThreadId]));
const threadKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
const decodeThreadKeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));

type ThreadLinkMetadataResult = Atom.Type<
  ReturnType<typeof orchestrationEnvironment.threadLinkMetadata>
>;

function mapsEqual<K, V>(
  prev: ReadonlyMap<K, V> | undefined,
  next: ReadonlyMap<K, V>,
): prev is ReadonlyMap<K, V> {
  if (prev === undefined || prev.size !== next.size) return false;
  for (const [k, v] of next) {
    if (!prev.has(k) || !Object.is(prev.get(k), v)) return false;
  }
  return true;
}

const isPartialThreadLinkMetadataError = Schema.is(PartialThreadLinkMetadataError);

interface ParsedThreadLinkMetadata {
  readonly result: ThreadLinkMetadataResult;
  readonly partial: PartialThreadLinkMetadataError | undefined;
  readonly failedIds: ReadonlySet<ThreadId> | undefined;
}

type ThreadLinkMetadataOutcome =
  | {
      readonly kind: "found";
      readonly entry: OrchestrationV2ThreadLinkMetadata;
      readonly settled: boolean;
    }
  | { readonly kind: "miss" }
  | { readonly kind: "failed" }
  | { readonly kind: "pending" };

function parseThreadLinkMetadata(result: ThreadLinkMetadataResult): ParsedThreadLinkMetadata {
  if (AsyncResult.isFailure(result) && !result.waiting) {
    const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
    if (isPartialThreadLinkMetadataError(error)) {
      return { result, partial: error, failedIds: new Set(error.failedThreadIds) };
    }
  }
  return { result, partial: undefined, failedIds: undefined };
}

function readMetadataOutcome(
  parsed: ParsedThreadLinkMetadata | undefined,
  threadId: ThreadId,
): ThreadLinkMetadataOutcome {
  if (parsed === undefined) return { kind: "pending" };
  const { result, partial, failedIds } = parsed;
  if (AsyncResult.isSuccess(result)) {
    if (Object.hasOwn(result.value, threadId)) {
      const entry = result.value[threadId];
      if (entry !== undefined) return { kind: "found", entry, settled: !result.waiting };
    }
    return result.waiting ? { kind: "pending" } : { kind: "miss" };
  }
  if (AsyncResult.isFailure(result) && !result.waiting) {
    if (partial !== undefined) {
      if (Object.hasOwn(partial.metadata, threadId)) {
        const entry = partial.metadata[threadId];
        if (entry !== undefined) return { kind: "found", entry, settled: true };
      }
      return failedIds?.has(threadId) ? { kind: "failed" } : { kind: "miss" };
    }
    return { kind: "failed" };
  }
  return { kind: "pending" };
}

function readFoundMetadataEntry(
  parsed: ParsedThreadLinkMetadata | undefined,
  threadId: ThreadId,
): OrchestrationV2ThreadLinkMetadata | undefined {
  const outcome = readMetadataOutcome(parsed, threadId);
  return outcome.kind === "found" ? outcome.entry : undefined;
}

function isIndexedLink(
  refKeySet: ReadonlySet<string>,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): boolean {
  return threadLinkCandidates(link, messageEnvironmentId).every((candidate) =>
    refKeySet.has(threadKey(candidate)),
  );
}

const CONFIRMED_THREAD_TITLES_LIMIT = 2048;
// Carries confirmed local titles (or null for a confirmed miss) across keys while metadata loads.
const confirmedThreadTitlesByRegistry = new WeakMap<
  AtomRegistry.AtomRegistry,
  Map<string, string | null>
>();

function confirmedTitlesFor(registry: AtomRegistry.AtomRegistry): Map<string, string | null> {
  let titles = confirmedThreadTitlesByRegistry.get(registry);
  if (titles === undefined) {
    titles = new Map();
    confirmedThreadTitlesByRegistry.set(registry, titles);
  }
  return titles;
}

// Non-reactive registry handle for read-only callers without direct registry access.
const confirmedThreadTitlesAtom = Atom.make((get) => confirmedTitlesFor(get.registry)).pipe(
  Atom.withLabel("mobile-confirmed-thread-titles"),
);

function rememberConfirmedTitle(
  titles: Map<string, string | null>,
  refKey: string,
  title: string | null,
) {
  titles.delete(refKey);
  titles.set(refKey, title);
  while (titles.size > CONFIRMED_THREAD_TITLES_LIMIT) {
    const oldest = titles.keys().next().value;
    if (oldest === undefined) break;
    titles.delete(oldest);
  }
}

function resolveThreadLinkWith(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  isKnown: (candidate: ScopedThreadRef) => boolean,
  readThreadRefs: () => ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const known = threadLinkCandidates(link, messageEnvironmentId).find(isKnown);
  if (known) return known;
  return link.environmentId === null
    ? guessThreadLinkRef(link, readThreadRefs())
    : scopeThreadRef(link.environmentId, link.threadId);
}

// Batch omitted/archived targets per environment so a message with many thread links issues
// one shared metadata query instead of N individual queries that each re-render the message.
function readBatchedThreadLinkMetadata(
  read: <A>(atom: Atom.Atom<A>) => A,
  refs: ReadonlyArray<ScopedThreadRef>,
) {
  const shells = new Map<string, EnvironmentThreadShell | null>();
  const missingByEnv = new Map<EnvironmentId, Set<ThreadId>>();
  for (const ref of refs) {
    const refKey = threadKey(ref);
    if (shells.has(refKey)) continue;
    const shell = read(environmentThreadShells.quietThreadShellAtom(ref));
    shells.set(refKey, shell);
    if (shell === null) {
      let ids = missingByEnv.get(ref.environmentId);
      if (ids === undefined) {
        ids = new Set();
        missingByEnv.set(ref.environmentId, ids);
      }
      ids.add(ref.threadId);
    }
  }
  const metadataByEnv = new Map<EnvironmentId, ParsedThreadLinkMetadata>();
  for (const [environmentId, ids] of missingByEnv) {
    metadataByEnv.set(
      environmentId,
      parseThreadLinkMetadata(
        read(
          orchestrationEnvironment.threadLinkMetadata({
            environmentId,
            input: { threadIds: [...ids].sort() },
          }),
        ),
      ),
    );
  }
  return { shells, metadataByEnv };
}

function resolveThreadLinkFromTitles(
  titles: ReadonlyMap<string, ThreadLinkTitle>,
  confirmedTitles: ReadonlyMap<string, string | null>,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  readThreadRefs: () => ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  return resolveThreadLinkWith(
    link,
    messageEnvironmentId,
    (candidate) => {
      const key = threadKey(candidate);
      return confirmedTitles.get(key) !== null && typeof titles.get(key) === "string";
    },
    readThreadRefs,
  );
}

const threadLinkTitlesAtom = Atom.family((key: string) => {
  const refEntries = decodeThreadKeys(JSON.parse(key)).map((refKey) => ({
    refKey,
    ref: scopeThreadRef(...decodeThreadKey(JSON.parse(refKey))),
  }));
  const refs = refEntries.map((entry) => entry.ref);
  return Atom.make((get) => {
    const previous = Option.getOrUndefined(get.self<ReadonlyMap<string, ThreadLinkTitle>>());
    const confirmedTitles = confirmedTitlesFor(get.registry);
    const { shells, metadataByEnv } = readBatchedThreadLinkMetadata(get, refs);
    const titles = new Map<string, ThreadLinkTitle>();
    for (const { refKey, ref } of refEntries) {
      const shell = shells.get(refKey);
      if (shell !== null && shell !== undefined) {
        titles.set(refKey, shell.title);
        rememberConfirmedTitle(confirmedTitles, refKey, shell.title);
        continue;
      }
      const outcome = readMetadataOutcome(metadataByEnv.get(ref.environmentId), ref.threadId);
      if (outcome.kind === "found") {
        titles.set(refKey, outcome.entry.title);
        if (outcome.settled) rememberConfirmedTitle(confirmedTitles, refKey, outcome.entry.title);
        continue;
      }
      if (outcome.kind === "miss") {
        rememberConfirmedTitle(confirmedTitles, refKey, null);
        continue;
      }
      if (outcome.kind === "failed") {
        if (confirmedTitles.get(refKey) !== null) confirmedTitles.delete(refKey);
        titles.set(refKey, FALLBACK_THREAD_TITLE);
        continue;
      }
      // Pending: display this key's previous title without writing it back as shared confirmation.
      const pendingTitle =
        previous !== undefined
          ? (previous.get(refKey) ?? null)
          : (confirmedTitles.get(refKey) ?? FALLBACK_THREAD_TITLE);
      if (pendingTitle !== null) titles.set(refKey, pendingTitle);
    }
    return mapsEqual(previous, titles) ? previous : titles;
  }).pipe(Atom.withLabel(`mobile-thread-link-titles:${key}`));
});

const decodeThreadChipIconsKey = Schema.decodeUnknownSync(
  Schema.Struct({
    targets: Schema.Array(
      Schema.Struct({
        href: Schema.String,
        environmentId: EnvironmentId,
        threadId: ThreadId,
        link: Schema.Boolean,
      }),
    ),
    metadataRefKeys: Schema.Array(Schema.String),
  }),
);

const EMPTY_THREAD_CHIP_ICONS: ReadonlyMap<string, string> = new Map();
const EMPTY_THREAD_CHIP_ICONS_ATOM = Atom.make(EMPTY_THREAD_CHIP_ICONS).pipe(
  Atom.withLabel("mobile-thread-chip-icons:empty"),
);

const threadChipIconsAtom = Atom.family((key: string) => {
  const parsed = decodeThreadChipIconsKey(JSON.parse(key));
  const targets = parsed.targets.map((target) => {
    const link = target.link ? parseThreadLinkHref(target.href) : null;
    return { target, link };
  });
  const candidateRefs = parsed.metadataRefKeys.map((refKey) =>
    scopeThreadRef(...decodeThreadKey(JSON.parse(refKey))),
  );
  const titlesAtom =
    parsed.metadataRefKeys.length > 0
      ? threadLinkTitlesAtom(JSON.stringify(parsed.metadataRefKeys))
      : EMPTY_THREAD_LINK_TITLES_ATOM;
  return Atom.make((get) => {
    const previous = Option.getOrUndefined(get.self<ReadonlyMap<string, string>>());
    const titles = get(titlesAtom);
    const confirmedTitles = confirmedTitlesFor(get.registry);
    const { shells, metadataByEnv } = readBatchedThreadLinkMetadata(get, candidateRefs);
    const icons = new Map<string, string>();
    const iconCache = new Map<string, string | null>();
    let cachedThreadRefs: ReadonlyArray<ScopedThreadRef> | undefined;
    const resolveIcon = (
      ref: ScopedThreadRef,
    ): { readonly uri: string | null; readonly pending: boolean } => {
      const refKey = threadKey(ref);
      const knownShell = shells.get(refKey);
      const shell =
        knownShell !== undefined
          ? knownShell
          : get(environmentThreadShells.quietThreadShellAtom(ref));
      const outcome = readMetadataOutcome(metadataByEnv.get(ref.environmentId), ref.threadId);
      const metadataEntry = outcome.kind === "found" ? outcome.entry : undefined;
      const pending = shell === null && outcome.kind === "pending";
      const cached = iconCache.get(refKey);
      if (cached !== undefined) return { uri: cached, pending };
      const metadata = shell ?? metadataEntry;
      const project = metadata?.projectId
        ? get(
            environmentProjects.projectAtom({
              environmentId: ref.environmentId,
              projectId: metadata.projectId,
            }),
          )
        : null;
      const icon = resolveProjectChipIcon(
        project,
        get(serverEnvironment.configValueAtom(ref.environmentId))?.scratchWorkspaceRoot,
        () =>
          project
            ? get(
                projectFaviconUrlAtom({
                  environmentId: ref.environmentId,
                  cwd: project.workspaceRoot,
                  faviconPath: project.faviconPath,
                }),
              )
            : null,
      );
      const uri = !icon
        ? null
        : icon.kind === "favicon"
          ? icon.uri
          : AsyncResult.getOrElse(get(projectGlyphImageAtom(projectGlyphKey(icon))), () => null);
      iconCache.set(refKey, uri);
      return { uri, pending };
    };

    for (const { target, link } of targets) {
      const ref = link
        ? (resolveThreadLinkFromTitles(titles, confirmedTitles, link, target.environmentId, () => {
            cachedThreadRefs ??= get(environmentThreadShells.threadRefsAtom);
            return cachedThreadRefs;
          }) ?? scopeThreadRef(target.environmentId, target.threadId))
        : scopeThreadRef(target.environmentId, target.threadId);
      const { uri, pending } = resolveIcon(ref);
      const resolvedUri = uri ?? (pending ? (previous?.get(target.href) ?? null) : null);
      if (resolvedUri) icons.set(target.href, resolvedUri);
    }
    return mapsEqual(previous, icons) ? previous : icons;
  }).pipe(Atom.withLabel(`mobile-thread-chip-icons:${key}`));
});

export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectAtom(ref);
  const current = appAtomRegistry.get(atom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, finish);
    finish(appAtomRegistry.get(atom));
  });
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

/** Thread shells minus those the tag filter hides, for lists that show threads to the user. */
export function useVisibleThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.visibleThreadShellsAtom);
}

/** Tasks linked environments run for a listed thread, by thread key; lists show them under it. */
export function useDelegatedUnderParent(): ReadonlySet<string> {
  return useAtomValue(environmentThreadShells.delegatedUnderParentAtom);
}

export function useNavigationThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

/** Streaming timestamps, item counts, and the latest message can be stale during a run. */
export function useQuietThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.quietThreadShellAtom(ref),
  );
}

export function useChildThreadInputs(ref: ScopedThreadRef) {
  return useAtomValue(environmentThreadShells.childThreadInputsAtom(ref));
}

export function useSideChats(ref: ScopedThreadRef) {
  return useAtomValue(environmentThreadShells.sideChatsAtom(ref));
}

const NO_LINKED_ENVIRONMENTS: ReadonlyMap<EnvironmentId, string> = new Map();

export interface MessageThreadLinkLookup {
  readonly refKeys: ReadonlyArray<string>;
  readonly refKeysKey: string | null;
  readonly refKeySet: ReadonlySet<string>;
  readonly resolve: (
    link: ThreadLink,
    read: <A>(atom: Atom.Atom<A>) => A,
  ) => ScopedThreadRef | null;
  readonly titleFor: (ref: ScopedThreadRef) => string | null;
}

export interface MessageThreadLinks extends MessageThreadLinkLookup {
  readonly markdown: string;
}

/**
 * Resolves thread links once per message so relabeling, chip icons, iOS context menus,
 * and tap handlers all share the same confirmed target set without re-parsing markdown.
 */
export function useMessageThreadLinks(
  markdown: string,
  environmentId: EnvironmentId,
  linked = NO_LINKED_ENVIRONMENTS,
): MessageThreadLinks {
  const resolve = useMessages();
  const gt = useGT();
  const refKeys = hasThreadLinks(markdown)
    ? [...new Set(threadLinkRefs(markdown, environmentId).map(threadKey))].sort()
    : [];
  const refKeySet = new Set(refKeys);
  const refKeysKey = refKeys.length > 0 ? JSON.stringify(refKeys) : null;
  const titles = useAtomValue(
    refKeysKey !== null ? threadLinkTitlesAtom(refKeysKey) : EMPTY_THREAD_LINK_TITLES_ATOM,
  );
  const liveMarkdown = relabelThreadLinks(
    markdown,
    environmentId,
    (ref, label) => {
      const title = titles.get(threadKey(ref));
      if (typeof title === "string") return title;
      // A thread only the message's environment can reach keeps its written name.
      const machine = linked.get(ref.environmentId);
      if (machine !== undefined) {
        return label?.trim() || gt("Thread on {label}", { label: machine });
      }
      return title && resolve(msg("Thread", { $context: "fallback title of a linked thread" }));
    },
    resolve,
  );
  return {
    markdown: liveMarkdown,
    refKeys,
    refKeysKey,
    refKeySet,
    resolve: (link, read) =>
      isIndexedLink(refKeySet, link, environmentId)
        ? resolveThreadLinkFromTitles(
            titles,
            read(confirmedThreadTitlesAtom),
            link,
            environmentId,
            () => read(environmentThreadShells.threadRefsAtom),
          )
        : resolveThreadLink(read, link, environmentId),
    titleFor: (ref) => {
      const title = titles.get(threadKey(ref));
      return typeof title === "string" ? title : null;
    },
  };
}

/** `linked` names the machines `environmentId` links to, whose threads open read-only. */
export function useLiveThreadLinkLabels(
  markdown: string,
  environmentId: EnvironmentId,
  linked = NO_LINKED_ENVIRONMENTS,
): string {
  return useMessageThreadLinks(markdown, environmentId, linked).markdown;
}

export interface ResolvedThreadLinkTarget {
  readonly ref: ScopedThreadRef;
  readonly title: string | null;
}

/** Keyed reads; every thread is read only to place a v1 link its message's environment lacks. */
export function resolveThreadLinkTarget(
  read: <A>(atom: Atom.Atom<A>) => A,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  messageIndex?: Pick<MessageThreadLinkLookup, "refKeysKey" | "refKeySet"> | null,
): ResolvedThreadLinkTarget | null {
  if (
    messageIndex?.refKeysKey &&
    isIndexedLink(messageIndex.refKeySet, link, messageEnvironmentId)
  ) {
    const titles = read(threadLinkTitlesAtom(messageIndex.refKeysKey));
    const confirmedTitles = read(confirmedThreadTitlesAtom);
    const ref = resolveThreadLinkFromTitles(
      titles,
      confirmedTitles,
      link,
      messageEnvironmentId,
      () => read(environmentThreadShells.threadRefsAtom),
    );
    if (ref === null) return null;
    const cachedTitle = titles.get(threadKey(ref));
    return {
      ref,
      title:
        typeof cachedTitle === "string"
          ? cachedTitle
          : (read(environmentThreadShells.quietThreadShellAtom(ref))?.title ?? null),
    };
  }
  const candidates = threadLinkCandidates(link, messageEnvironmentId);
  const { shells, metadataByEnv } = readBatchedThreadLinkMetadata(read, candidates);
  const ref = resolveThreadLinkWith(
    link,
    messageEnvironmentId,
    (candidate) => {
      const shell = shells.get(threadKey(candidate));
      if (shell !== null && shell !== undefined) return true;
      return (
        readFoundMetadataEntry(metadataByEnv.get(candidate.environmentId), candidate.threadId) !==
        undefined
      );
    },
    () => read(environmentThreadShells.threadRefsAtom),
  );
  if (ref === null) return null;
  const refKey = threadKey(ref);
  const knownShell = shells.get(refKey);
  const title =
    knownShell !== undefined
      ? (knownShell?.title ??
        readFoundMetadataEntry(metadataByEnv.get(ref.environmentId), ref.threadId)?.title ??
        null)
      : (read(environmentThreadShells.quietThreadShellAtom(ref))?.title ?? null);
  return { ref, title };
}

export function resolveThreadLink(
  read: <A>(atom: Atom.Atom<A>) => A,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  messageIndex?: Pick<MessageThreadLinkLookup, "refKeysKey" | "refKeySet"> | null,
): ScopedThreadRef | null {
  return resolveThreadLinkTarget(read, link, messageEnvironmentId, messageIndex)?.ref ?? null;
}

export function useThreadChipIcons(
  environmentId: EnvironmentId,
  markdown: string,
  options?: {
    readonly records?: ReadonlyArray<ComposerContextRecord> | undefined;
    readonly sourceRefKeys?: ReadonlyArray<string> | undefined;
  },
): ReadonlyMap<string, string> {
  const records = options?.records;
  const sourceRefKeys = options?.sourceRefKeys;
  const targets = threadChipTargets(environmentId, markdown, records);
  let atom: Atom.Atom<ReadonlyMap<string, string>> = EMPTY_THREAD_CHIP_ICONS_ATOM;
  if (targets.length > 0) {
    const metadataRefKeys = new Set<string>(sourceRefKeys);
    if (sourceRefKeys === undefined && hasThreadLinks(markdown)) {
      for (const ref of threadLinkRefs(markdown, environmentId)) {
        metadataRefKeys.add(threadKey(ref));
      }
    }
    for (const target of targets) {
      const link = target.link ? parseThreadLinkHref(target.href) : null;
      const candidates = link
        ? threadLinkCandidates(link, target.environmentId)
        : [scopeThreadRef(target.environmentId, target.threadId)];
      for (const candidate of candidates) {
        metadataRefKeys.add(threadKey(candidate));
      }
    }
    atom = threadChipIconsAtom(
      JSON.stringify({
        targets,
        metadataRefKeys: [...metadataRefKeys].sort(),
      }),
    );
  }
  return useAtomValue(atom);
}

export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
}

/** Whether the environment turned its preview tunnel off; false until its config loads. */
export function useEnvironmentPreviewTunnelOff(environmentId: EnvironmentId | null): boolean {
  const config = useEnvironmentServerConfig(environmentId);
  return config !== null && !allowsPreviewTunnel(config);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

const selectReportedModelSelection = (thread: EnvironmentThread | null) =>
  thread === null ? null : deriveReportedModelSelection(thread.projection);

export function useThreadReportedModelSelection(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_ATOM : environmentThreadDetails.threadAtom(ref),
    selectReportedModelSelection,
  );
}
