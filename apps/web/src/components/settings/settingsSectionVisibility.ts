type VisibilityEntry = Pick<
  IntersectionObserverEntry,
  "intersectionRatio" | "isIntersecting" | "target"
>;

export type SettingsSectionVisibilityScope = {
  readonly path: string;
};

export type SettingsSectionVisibilityState = {
  readonly scope: SettingsSectionVisibilityScope;
  readonly targetIds: ReadonlySet<string>;
};

const EMPTY_VISIBLE_SETTINGS_SECTION_IDS: ReadonlySet<string> = new Set();

export function getVisibleSettingsSectionIds({
  activePath,
  scope,
  visibility,
}: {
  readonly activePath: string | undefined;
  readonly scope: SettingsSectionVisibilityScope | null;
  readonly visibility: SettingsSectionVisibilityState | null;
}): ReadonlySet<string> {
  if (!scope || activePath !== scope.path || visibility?.scope !== scope) {
    return EMPTY_VISIBLE_SETTINGS_SECTION_IDS;
  }
  return visibility.targetIds;
}

type ElementObserver = {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
};

type MutationSubscription = {
  disconnect(): void;
};

export type SettingsSectionVisibilityEnvironment = {
  findRoot(container: Element): Element | null;
  findTarget(root: Element, targetId: string): Element | null;
  createIntersectionObserver(
    onEntries: (entries: ReadonlyArray<VisibilityEntry>) => void,
    root: Element,
  ): ElementObserver;
  createMutationObserver(onMutation: () => void, container: Element): MutationSubscription;
};

function createBrowserEnvironment(): SettingsSectionVisibilityEnvironment {
  return {
    findRoot(container) {
      return container.querySelector("[data-settings-page-scroll]");
    },
    findTarget(root, targetId) {
      const target = root.ownerDocument.getElementById(targetId);
      return target && root.contains(target) ? target : null;
    },
    createIntersectionObserver(onEntries, scrollRoot) {
      const observer = new IntersectionObserver(onEntries, {
        root: scrollRoot,
        threshold: 0,
      });
      return observer;
    },
    createMutationObserver(onMutation, container) {
      const observer = new MutationObserver(onMutation);
      observer.observe(container, { childList: true, subtree: true });
      return observer;
    },
  };
}

export function observeSettingsSectionVisibility({
  container,
  targetIds,
  onChange,
  environment = createBrowserEnvironment(),
}: {
  readonly container: Element;
  readonly targetIds: ReadonlyArray<string>;
  readonly onChange: (visibleTargetIds: ReadonlyArray<string>) => void;
  readonly environment?: SettingsSectionVisibilityEnvironment;
}): () => void {
  const orderedTargetIds = [...new Set(targetIds)];
  const targetsById = new Map<string, Element>();
  const targetIdsByElement = new Map<Element, string>();
  const visibleTargetIds = new Set<string>();
  let lastEmission: string | null = null;
  let stopped = false;
  let root: Element | null = null;
  let intersectionObserver: ElementObserver | null = null;
  let observerGeneration = 0;

  const emit = () => {
    const visibleInOrder = orderedTargetIds.filter((targetId) => visibleTargetIds.has(targetId));
    const emissionKey = visibleInOrder.join("\0");
    if (emissionKey === lastEmission) return;
    lastEmission = emissionKey;
    onChange(visibleInOrder);
  };

  const handleEntries = (entries: ReadonlyArray<VisibilityEntry>, generation: number) => {
    if (stopped || generation !== observerGeneration) return;
    let changed = false;
    for (const entry of entries) {
      const targetId = targetIdsByElement.get(entry.target);
      if (!targetId || targetsById.get(targetId) !== entry.target) continue;
      const visible = entry.isIntersecting && entry.intersectionRatio > 0;
      if (visible === visibleTargetIds.has(targetId)) continue;
      changed = true;
      if (visible) {
        visibleTargetIds.add(targetId);
      } else {
        visibleTargetIds.delete(targetId);
      }
    }
    if (changed) emit();
  };

  const syncTargets = () => {
    if (stopped) return;
    let changed = false;
    const nextRoot = environment.findRoot(container);

    if (nextRoot !== root) {
      observerGeneration += 1;
      intersectionObserver?.disconnect();
      intersectionObserver = null;
      root = nextRoot;
      targetsById.clear();
      targetIdsByElement.clear();
      changed = visibleTargetIds.size > 0;
      visibleTargetIds.clear();

      if (root) {
        const generation = observerGeneration;
        intersectionObserver = environment.createIntersectionObserver(
          (entries) => handleEntries(entries, generation),
          root,
        );
      }
    }

    if (!root || !intersectionObserver) {
      if (changed) emit();
      return;
    }

    for (const targetId of orderedTargetIds) {
      const previousTarget = targetsById.get(targetId) ?? null;
      const nextTarget = environment.findTarget(root, targetId);
      if (previousTarget === nextTarget) continue;

      if (previousTarget) {
        intersectionObserver.unobserve(previousTarget);
        targetsById.delete(targetId);
        targetIdsByElement.delete(previousTarget);
        changed = visibleTargetIds.delete(targetId) || changed;
      }
      if (nextTarget) {
        targetsById.set(targetId, nextTarget);
        targetIdsByElement.set(nextTarget, targetId);
        intersectionObserver.observe(nextTarget);
      }
    }

    if (changed) emit();
  };

  const mutationObserver = environment.createMutationObserver(syncTargets, container);
  syncTargets();
  emit();

  return () => {
    stopped = true;
    observerGeneration += 1;
    intersectionObserver?.disconnect();
    mutationObserver.disconnect();
    targetsById.clear();
    targetIdsByElement.clear();
    visibleTargetIds.clear();
  };
}
