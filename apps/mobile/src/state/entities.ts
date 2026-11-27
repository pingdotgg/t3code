import { useAtomValue } from "@effect/atom-react";
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
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
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

// Omitted and archived targets need only a metadata lookup, not their conversation history.
const threadTitleAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  return Atom.make((get): ThreadLinkTitle | null => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell !== null) return shell.title;
    const titles = get(
      orchestrationEnvironment.threadLinkMetadata({
        environmentId: ref.environmentId,
        input: { threadIds: [ref.threadId] },
      }),
    );
    return AsyncResult.isSuccess(titles)
      ? (titles.value[ref.threadId]?.title ?? (titles.waiting ? FALLBACK_THREAD_TITLE : null))
      : FALLBACK_THREAD_TITLE;
  }).pipe(Atom.withLabel(`mobile-thread-title:${key}`));
});

const decodeThreadKeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const threadLinkTitlesAtom = Atom.family((key: string) => {
  const refKeys = decodeThreadKeys(JSON.parse(key));
  return Atom.make((get) => {
    const titles = new Map<string, ThreadLinkTitle>();
    for (const refKey of refKeys) {
      const title = get(threadTitleAtom(refKey));
      if (title !== null) titles.set(refKey, title);
    }
    return titles;
  }).pipe(Atom.withLabel(`mobile-thread-link-titles:${key}`));
});

const decodeThreadChipTargets = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      href: Schema.String,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      link: Schema.Boolean,
    }),
  ),
);

export type ThreadChipPresentation =
  | { readonly kind: "archived"; readonly title: string }
  | { readonly kind: "project"; readonly uri: string };

const threadChipPresentationAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  return Atom.make((get): ThreadChipPresentation | null => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    const metadata =
      shell ??
      AsyncResult.getOrElse(
        get(
          orchestrationEnvironment.threadLinkMetadata({
            environmentId: ref.environmentId,
            input: { threadIds: [ref.threadId] },
          }),
        ),
        () => null,
      )?.[ref.threadId];
    if (
      metadata &&
      ("archivedAt" in metadata ? metadata.archivedAt !== null : metadata.archived === true)
    ) {
      return { kind: "archived", title: metadata.title };
    }
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
    if (!icon) return null;
    const uri =
      icon.kind === "favicon"
        ? icon.uri
        : AsyncResult.getOrElse(get(projectGlyphImageAtom(projectGlyphKey(icon))), () => null);
    return uri ? { kind: "project", uri } : null;
  }).pipe(Atom.withLabel(`mobile-thread-chip-presentation:${key}`));
});

const EMPTY_THREAD_CHIP_PRESENTATIONS = Atom.make<ReadonlyMap<string, ThreadChipPresentation>>(
  new Map(),
).pipe(Atom.withLabel("mobile-thread-chip-presentations:empty"));

const threadChipPresentationsAtom = Atom.family((key: string) => {
  const targets = decodeThreadChipTargets(JSON.parse(key));
  return Atom.make((get) => {
    const presentations = new Map<string, ThreadChipPresentation>();
    for (const target of targets) {
      const link = target.link ? parseThreadLinkHref(target.href) : null;
      const ref =
        (link ? resolveThreadLink(get, link, target.environmentId) : null) ??
        scopeThreadRef(target.environmentId, target.threadId);
      const presentation = get(threadChipPresentationAtom(threadKey(ref)));
      if (presentation) presentations.set(target.href, presentation);
    }
    return presentations;
  }).pipe(Atom.withLabel(`mobile-thread-chip-presentations:${key}`));
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

/** `linked` names the machines `environmentId` links to, whose threads open read-only. */
export function useLiveThreadLinkLabels(
  markdown: string,
  environmentId: EnvironmentId,
  linked = NO_LINKED_ENVIRONMENTS,
): string {
  const resolve = useMessages();
  const gt = useGT();
  const titles = useAtomValue(
    hasThreadLinks(markdown)
      ? threadLinkTitlesAtom(JSON.stringify(threadLinkRefs(markdown, environmentId).map(threadKey)))
      : EMPTY_THREAD_LINK_TITLES_ATOM,
  );
  return relabelThreadLinks(
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
}

/** Keyed reads; every thread is read only to place a v1 link its message's environment lacks. */
export function resolveThreadLink(
  read: <A>(atom: Atom.Atom<A>) => A,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ScopedThreadRef | null {
  const known = threadLinkCandidates(link, messageEnvironmentId).find((ref) => {
    if (read(environmentThreadShells.threadShellAtom(ref)) !== null) return true;
    const metadata = read(
      orchestrationEnvironment.threadLinkMetadata({
        environmentId: ref.environmentId,
        input: { threadIds: [ref.threadId] },
      }),
    );
    return AsyncResult.getOrElse(metadata, () => null)?.[ref.threadId] !== undefined;
  });
  if (known) return known;
  return link.environmentId === null
    ? guessThreadLinkRef(link, read(environmentThreadShells.threadRefsAtom))
    : scopeThreadRef(link.environmentId, link.threadId);
}

export function useThreadChipPresentations(
  environmentId: EnvironmentId,
  markdown: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): ReadonlyMap<string, ThreadChipPresentation> {
  const targets = threadChipTargets(environmentId, markdown, records);
  return useAtomValue(
    targets.length === 0
      ? EMPTY_THREAD_CHIP_PRESENTATIONS
      : threadChipPresentationsAtom(JSON.stringify(targets)),
  );
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
