import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

interface PackageState {
  tags: string[];
  expiresAt: number;
  downloads: Record<string, number>;
  totalDownloads: number;
}

const emptyState: PackageState = {
  tags: [],
  expiresAt: 0,
  downloads: {},
  totalDownloads: 0,
};

export default class PackageStore extends Cloudflare.DurableObjectNamespace<PackageStore>()(
  "PackageStore",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const doState = yield* Cloudflare.DurableObjectState;

      const getState = Effect.gen(function* () {
        const stored = yield* doState.storage.get<PackageState>("state");
        return stored ?? emptyState;
      });

      const setState = (s: PackageState) => doState.storage.put("state", s);

      return {
        init: (tags: string[], expiresAt: number) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const merged = new Set([...current.tags, ...tags]);
            const newState: PackageState = {
              tags: [...merged],
              expiresAt,
              downloads: current.downloads,
              totalDownloads: current.totalDownloads,
            };
            yield* setState(newState);
          }),

        removeTag: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const tags = current.tags.filter((t) => t !== tag);
            yield* setState({ ...current, tags });
            return { orphaned: tags.length === 0 };
          }),

        recordDownload: (tag: string) =>
          Effect.gen(function* () {
            const current = yield* getState;
            const downloads = { ...current.downloads };
            downloads[tag] = (downloads[tag] ?? 0) + 1;
            yield* setState({
              ...current,
              downloads,
              totalDownloads: current.totalDownloads + 1,
            });
          }),

        getStats: () =>
          Effect.gen(function* () {
            const current = yield* getState;
            return {
              downloads: current.downloads,
              totalDownloads: current.totalDownloads,
            };
          }),

        getState: () => getState,
      };
    });
  }),
) {}
