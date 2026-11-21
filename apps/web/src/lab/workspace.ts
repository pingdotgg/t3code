// The conn project's workspace as the lab's fake environment serves it to the Files and Database
// panels (projects.listEntries / readFile / searchEntries in labDriver.ts). The contents are the
// repo's real sources, loaded raw by Vite on demand; the root files and the .env are inline.
import rootPackageJson from "../../../../package.json?raw";
import rootReadme from "../../../../README.md?raw";
import webPackageJson from "../../package.json?raw";

const sources = import.meta.glob(
  [
    "../components/ui/{button,input-group,menu,badge,tooltip,scroll-area,checkbox,switch}.tsx",
    "../components/files/{FileBreadcrumbs,FileExplorerPane,FileBrowserPanel,ReadOnlySourcePreview}.tsx",
    "../components/chat/{MarkdownCodeBlock,ThreadStatusLine,ThreadNow,ComposerPendingUserInputPanel}.tsx",
    "../components/{StatusDotBadge,ToolbarGroup}.tsx",
    "../orbit/tasks/*.{ts,tsx}",
    "!../orbit/tasks/*.test.*",
    "../database/{DatabasePanel,databaseApi,databaseStore}.{ts,tsx}",
    "../lib/{utils,observeResize,lruCache}.ts",
    "../hooks/{useTheme,useNowMinute}.ts",
    "../rightPanelStore.ts",
    "../main.tsx",
  ],
  { query: "?raw", import: "default" },
) as Record<string, () => Promise<string>>;

const ENV = [
  "APP_NAME=Conn",
  "APP_ENV=local",
  "APP_URL=http://conn.test",
  "",
  "DB_CONNECTION=pgsql",
  "DB_HOST=app-db.orbit",
  "DB_PORT=5432",
  "DB_DATABASE=conn_app",
  "DB_USERNAME=conn",
  "DB_PASSWORD=secret",
  "",
  "ORBIT_GATEWAY_URL=https://gateway.orbit.example",
].join("\n");

type Loader = () => Promise<string>;
const text =
  (contents: string): Loader =>
  () =>
    Promise.resolve(contents);

const loaders = new Map<string, Loader>([
  ["README.md", text(rootReadme)],
  ["package.json", text(rootPackageJson)],
  ["apps/web/package.json", text(webPackageJson)],
  [".env", text(ENV)],
  [".gitignore", text("node_modules\ndist\n.env\n.t3\n")],
]);
for (const [key, load] of Object.entries(sources))
  loaders.set(`apps/web/src/${key.slice(3)}`, load);

const FILE_PATHS = [...loaders.keys()].sort();

export interface LabEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

const DIRECTORY_PATHS = [
  ...new Set(
    FILE_PATHS.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  ),
].sort();

const ALL_ENTRIES: ReadonlyArray<LabEntry> = [
  ...DIRECTORY_PATHS.map((path): LabEntry => ({ path, kind: "directory" })),
  ...FILE_PATHS.map((path): LabEntry => ({ path, kind: "file" })),
];

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The whole tree, or one directory's immediate children, as the server lists them. */
export function labListEntries(directoryPath: string | undefined): ReadonlyArray<LabEntry> {
  if (directoryPath === undefined) return ALL_ENTRIES;
  const directory = directoryPath.replace(/^\/+|\/+$/g, "");
  return ALL_ENTRIES.filter((entry) => parentOf(entry.path) === directory);
}

export function labSearchEntries(query: string, limit: number, kind: LabEntry["kind"] | undefined) {
  const needle = query.trim().toLowerCase();
  const matches = ALL_ENTRIES.filter(
    (entry) =>
      (kind === undefined || entry.kind === kind) &&
      (needle === "" || entry.path.toLowerCase().includes(needle)),
  );
  return { entries: matches.slice(0, limit), truncated: matches.length > limit };
}

/** The file's text, or null when the lab workspace has no such file. */
export async function labReadFile(relativePath: string): Promise<string | null> {
  const load = loaders.get(relativePath.replace(/^\.\//, ""));
  return load ? await load() : null;
}
