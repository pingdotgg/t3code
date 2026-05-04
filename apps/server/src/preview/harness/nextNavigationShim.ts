import { useMemo } from "react";
import {
  getPreviewEnvironment,
  setPreviewEnvironment,
  usePreviewEnvironment,
  usePreviewSearchParams,
} from "./environmentStore.ts";

function createReadonlySearchParams(searchParams: URLSearchParams) {
  return {
    append: () => {
      throw new Error("Search params are read-only in the Forma preview harness.");
    },
    delete: () => {
      throw new Error("Search params are read-only in the Forma preview harness.");
    },
    get: (key: string) => searchParams.get(key),
    getAll: (key: string) => searchParams.getAll(key),
    has: (key: string) => searchParams.has(key),
    keys: () => searchParams.keys(),
    values: () => searchParams.values(),
    entries: () => searchParams.entries(),
    forEach: searchParams.forEach.bind(searchParams),
    set: () => {
      throw new Error("Search params are read-only in the Forma preview harness.");
    },
    sort: () => {
      throw new Error("Search params are read-only in the Forma preview harness.");
    },
    toString: () => searchParams.toString(),
    [Symbol.iterator]: () => searchParams[Symbol.iterator](),
  };
}

export function useSearchParams() {
  const searchParams = usePreviewSearchParams();
  return useMemo(() => createReadonlySearchParams(searchParams), [searchParams]);
}

export function usePathname() {
  return usePreviewEnvironment().pathname;
}

export function useParams() {
  return {};
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => {
        setPreviewEnvironment({ pathname: href });
      },
      replace: (href: string) => {
        setPreviewEnvironment({ pathname: href });
      },
      back: () => undefined,
      forward: () => undefined,
      refresh: () => undefined,
      prefetch: async () => undefined,
    }),
    [],
  );
}

export function redirect(href: string): never {
  throw new Error(`Forma preview redirect requested: ${href}`);
}

export function notFound(): never {
  throw new Error("Forma preview notFound() was called.");
}

export function permanentRedirect(href: string): never {
  throw new Error(`Forma preview permanentRedirect requested: ${href}`);
}

export function useSelectedLayoutSegment() {
  const pathname = usePreviewEnvironment().pathname;
  const segments = pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

export function useSelectedLayoutSegments() {
  return usePreviewEnvironment().pathname.split("/").filter(Boolean);
}

export function useServerInsertedHTML() {
  return undefined;
}

export function useLinkStatus() {
  return { pending: false };
}

export function useReportWebVitals() {
  return undefined;
}

export function useParamsState() {
  return getPreviewEnvironment();
}
