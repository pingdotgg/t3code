/** Compact trail kept in memory and flushed with fatal/error crash records. */

export type BreadcrumbData = Readonly<Record<string, string | number | boolean | null>>;

export type Breadcrumb = {
  readonly t: string;
  readonly type: string;
  readonly data?: BreadcrumbData;
};

const MAX_BREADCRUMBS = 80;

const ring: Breadcrumb[] = [];
let onBreadcrumbAdded: (() => void) | null = null;

/** Optional disk flusher installed by crashLog / breadcrumbPersist. */
export function setBreadcrumbPersistHook(hook: (() => void) | null): void {
  onBreadcrumbAdded = hook;
}

export function addBreadcrumb(type: string, data?: BreadcrumbData): void {
  const entry: Breadcrumb =
    data === undefined
      ? { t: new Date().toISOString(), type }
      : { t: new Date().toISOString(), type, data: sanitizeBreadcrumbData(data) };
  ring.push(entry);
  if (ring.length > MAX_BREADCRUMBS) {
    ring.splice(0, ring.length - MAX_BREADCRUMBS);
  }
  onBreadcrumbAdded?.();
}

export function getBreadcrumbs(): ReadonlyArray<Breadcrumb> {
  return ring.slice();
}

export function clearBreadcrumbs(): void {
  ring.length = 0;
}

export function breadcrumbCount(): number {
  return ring.length;
}

function sanitizeBreadcrumbData(data: BreadcrumbData): BreadcrumbData {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}
