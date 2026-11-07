import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { deriveReportedModelSelection } from "@t3tools/client-runtime/state/thread-execution";

import { appAtomRegistry } from "./atom-registry";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
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
  relabelThreadLinks,
  threadLinkCandidates,
  threadLinkRefs,
  type ThreadLink,
} from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadChipTargets } from "../lib/enrichedLinkPresentation";
import { resolveProjectChipIcon } from "../lib/projectIcon";
import { projectGlyphImageAtom, projectGlyphKey } from "../native/ProjectChipIconImages";
import { projectFaviconUrlAtom } from "./assets";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadDetails, environmentThreadShells, threadFamilies } from "./threads";

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
const EMPTY_THREAD_LINK_TITLES_ATOM = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
  Atom.withLabel("mobile-thread-link-titles:empty"),
);

const decodeThreadKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, ThreadId]));
const threadKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);

// Null when this client doesn't know the thread. Keyed, so a link never walks an environment's threads.
const threadTitleAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  return Atom.make((get) => get(environmentThreadShells.threadShellAtom(ref))?.title ?? null).pipe(
    Atom.withLabel(`mobile-thread-title:${key}`),
  );
});

const decodeThreadKeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const threadLinkTitlesAtom = Atom.family((key: string) => {
  const refKeys = decodeThreadKeys(JSON.parse(key));
  return Atom.make((get) => {
    const titles = new Map<string, string>();
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

const threadProjectChipIconAtom = Atom.family((key: string) => {
  const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
  return Atom.make((get): string | null => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    const project = shell
      ? get(
          environmentProjects.projectAtom({
            environmentId: ref.environmentId,
            projectId: shell.projectId,
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
    if (icon.kind === "favicon") return icon.uri;
    return AsyncResult.getOrElse(get(projectGlyphImageAtom(projectGlyphKey(icon))), () => null);
  }).pipe(Atom.withLabel(`mobile-thread-project-chip-icon:${key}`));
});

const EMPTY_THREAD_CHIP_ICONS: ReadonlyMap<string, string> = new Map();
const EMPTY_THREAD_CHIP_ICONS_ATOM = Atom.make(EMPTY_THREAD_CHIP_ICONS).pipe(
  Atom.withLabel("mobile-thread-chip-icons:empty"),
);

const threadChipIconsAtom = Atom.family((key: string) => {
  const targets = decodeThreadChipTargets(JSON.parse(key));
  return Atom.make((get) => {
    const icons = new Map<string, string>();
    for (const target of targets) {
      const link = target.link ? parseThreadLinkHref(target.href) : null;
      const ref =
        (link ? resolveThreadLink(get, link, target.environmentId) : null) ??
        scopeThreadRef(target.environmentId, target.threadId);
      const icon = get(threadProjectChipIconAtom(threadKey(ref)));
      if (icon) icons.set(target.href, icon);
    }
    return icons;
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

export function useLiveThreadLinkLabels(markdown: string, environmentId: EnvironmentId): string {
  const refs = hasThreadLinks(markdown) ? threadLinkRefs(markdown, environmentId) : [];
  const titles = useAtomValue(
    refs.length === 0
      ? EMPTY_THREAD_LINK_TITLES_ATOM
      : threadLinkTitlesAtom(JSON.stringify(refs.map(threadKey))),
  );
  // Shells leave out idle subagent children and older settled threads, so a cited thread the
  // shell lacks is read with its family until it lands; only a settled empty read proves it gone.
  const refsKey = JSON.stringify(refs.map(threadKey));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps cited families mounted until the links change; releasing on title arrival removes that title again
  useEffect(() => {
    const releases = (JSON.parse(refsKey) as ReadonlyArray<string>).map((key) => {
      const ref = scopeThreadRef(...decodeThreadKey(JSON.parse(key)));
      return threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId);
    });
    return () => {
      for (const release of releases) release();
    };
  }, [refsKey]);
  return relabelThreadLinks(markdown, environmentId, (ref) => titles.get(threadKey(ref)));
}

/** Keyed reads; every thread is read only to place a v1 link its message's environment lacks. */
export function resolveThreadLink(
  read: <A>(atom: Atom.Atom<A>) => A,
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ScopedThreadRef | null {
  const known = threadLinkCandidates(link, messageEnvironmentId).find(
    (ref) => read(threadTitleAtom(threadKey(ref))) !== null,
  );
  if (known) return known;
  return link.environmentId === null
    ? guessThreadLinkRef(link, read(environmentThreadShells.threadRefsAtom))
    : null;
}

export function useThreadChipIcons(
  environmentId: EnvironmentId,
  markdown: string,
  records?: ReadonlyArray<ComposerContextRecord>,
): ReadonlyMap<string, string> {
  const targets = threadChipTargets(environmentId, markdown, records);
  return useAtomValue(
    targets.length === 0
      ? EMPTY_THREAD_CHIP_ICONS_ATOM
      : threadChipIconsAtom(JSON.stringify(targets)),
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
