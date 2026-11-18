/**
 * Turns profile change notices into reads through the existing refresh, which stays the authority.
 * One read at a time; a notice that arrives during a read is compared with what it saw. A scope
 * switch makes in-flight work obsolete. `reconcile()` serves subscribe, reconnect, foreground and recovery.
 */

export interface ProfileBinding {
  readonly profileId: number;
  /** The settings document version the device holds after the read. */
  readonly version: number;
  /** The private channel `/me` named for this binding, or null when it named none. */
  readonly channel?: string | null;
}

export interface ProfileChangeNotice {
  readonly profileId: number;
  readonly version: number;
}

export interface ProfileReconcilePorts {
  /**
   * The local scope profile sync runs in (for example the provider and Gateway), or null while
   * it is off. A different value makes all earlier work obsolete.
   */
  readonly scope: () => string | null;
  /**
   * The existing authoritative refresh. Resolves to the profile this device is bound to, or null
   * when it is unbound. Must not apply anything once `isCurrent()` is false.
   */
  readonly refresh: (isCurrent: () => boolean) => Promise<ProfileBinding | null>;
  readonly onError?: (error: unknown) => void;
}

/** Follow-up reads in a row that still do not reach an announced version; the next trigger retries. */
const MAX_STALE_READS = 3;

export function createProfileReconciler(ports: ProfileReconcilePorts) {
  let disposed = false;
  let generation = 0;
  let scopeKey: string | null = null;
  /** undefined: not read in this scope yet; null: unbound. */
  let binding: ProfileBinding | null | undefined;
  /** The highest version announced per profile and not yet read. */
  const announced = new Map<number, number>();
  let running: Promise<void> | null = null;
  let requested = false;

  const reset = (): void => {
    generation += 1;
    binding = undefined;
    announced.clear();
  };

  /** Drops all state when the local scope changed since it was last seen. */
  const checkScope = (): string | null => {
    const current = ports.scope();
    if (current !== scopeKey) {
      scopeKey = current;
      reset();
    }
    return current;
  };

  const pending = (): boolean => {
    if (!binding) return false;
    const version = announced.get(binding.profileId);
    return version !== undefined && version > binding.version;
  };

  async function pump(): Promise<void> {
    try {
      let staleReads = 0;
      while (requested) {
        requested = false;
        if (disposed) return;
        const key = checkScope();
        if (key === null) return;
        const started = generation;
        const isCurrent = () => !disposed && generation === started && ports.scope() === key;
        let result: ProfileBinding | null;
        try {
          result = await ports.refresh(isCurrent);
        } catch (error) {
          // Announced versions stay; the next notice or trigger reads again.
          if (isCurrent()) ports.onError?.(error);
          else requested = !disposed;
          continue;
        }
        if (!isCurrent()) {
          // Read for the scope that replaced it, so a switch never ends on obsolete data.
          requested = !disposed;
          continue;
        }
        binding = result;
        for (const profileId of announced.keys()) {
          if (result === null || profileId !== result.profileId) announced.delete(profileId);
        }
        if (pending()) {
          staleReads += 1;
          if (staleReads < MAX_STALE_READS) requested = true;
        } else {
          staleReads = 0;
          if (result) announced.delete(result.profileId);
        }
      }
    } finally {
      // A notice after the loop exits must start a fresh drain.
      running = null;
    }
  }

  function request(): Promise<void> {
    requested = true;
    running ??= Promise.resolve().then(pump);
    return running;
  }

  return {
    /** Handles one notice from the subscription. Returns the read it joined, if any. */
    notify(notice: ProfileChangeNotice): Promise<void> | null {
      if (disposed || checkScope() === null) return null;
      if (
        !Number.isSafeInteger(notice.profileId) ||
        notice.profileId < 1 ||
        !Number.isSafeInteger(notice.version) ||
        notice.version < 0
      ) {
        return null;
      }
      const relevant =
        binding === undefined || (binding !== null && binding.profileId === notice.profileId);
      // A read in flight may find a new binding: keep the notice to compare after it.
      if (!relevant && running === null) return null;
      if (binding && binding.profileId === notice.profileId && notice.version <= binding.version) {
        return null;
      }
      const known = announced.get(notice.profileId);
      // Already announced: while idle that means its read failed or fell short, so retry it.
      if (known !== undefined && notice.version <= known) {
        return running ?? (relevant ? request() : null);
      }
      announced.set(notice.profileId, notice.version);
      if (running) return running;
      return relevant ? request() : null;
    },
    /** A full read: after subscribing or reconnecting, on foreground, and for recovery. */
    reconcile(): Promise<void> {
      if (disposed) return Promise.resolve();
      checkScope();
      return request();
    },
    /** Marks earlier work obsolete without a scope change (for example A, then B, then A again). */
    invalidate(): void {
      reset();
    },
    dispose(): void {
      disposed = true;
      reset();
    },
  };
}
