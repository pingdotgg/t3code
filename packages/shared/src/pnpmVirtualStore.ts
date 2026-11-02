// @effect-diagnostics nodeBuiltinImport:off - Vite and Metro load this before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Extra filesystem roots needed to serve packages from pnpm's external store. */
export function pnpmVirtualStoreFolders(workspaceRoot: string): string[] {
  const modulesRoot = NodePath.join(workspaceRoot, "node_modules");
  // pnpm writes JSON to .modules.yaml, including a custom store's actual path.
  let manifest: unknown;
  try {
    manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(modulesRoot, ".modules.yaml"), "utf8"));
  } catch {
    return [];
  }
  const virtualStoreDir =
    typeof manifest === "object" &&
    manifest !== null &&
    "virtualStoreDir" in manifest &&
    typeof manifest.virtualStoreDir === "string"
      ? manifest.virtualStoreDir
      : ".pnpm";
  const store = NodePath.resolve(modulesRoot, virtualStoreDir);
  const relative = NodePath.relative(workspaceRoot, store);
  return relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
    ? [store]
    : [];
}

/** Vite's default workspace root plus any external package store. */
export function pnpmViteFsAllow(appRoot: string): string[] {
  const workspaceRoot = NodePath.resolve(appRoot, "../..");
  return [workspaceRoot, ...pnpmVirtualStoreFolders(workspaceRoot)];
}

/** Metro crawls watch roots, so include reachable slots rather than every project's store. */
export function pnpmMetroWatchFolders(workspaceRoot: string): string[] {
  const stores = pnpmVirtualStoreFolders(workspaceRoot);
  if (stores.length === 0) return [];
  const slots = new Set<string>();
  const visited = new Set<string>();
  const pending = [
    NodePath.join(workspaceRoot, "node_modules"),
    NodePath.join(workspaceRoot, "apps/mobile/node_modules"),
    NodePath.join(workspaceRoot, "node_modules/.pnpm/node_modules"),
  ];
  while (pending.length > 0) {
    const modules = pending.pop();
    if (modules === undefined) break;
    if (visited.has(modules) || !NodeFS.existsSync(modules)) continue;
    visited.add(modules);
    for (const owner of NodeFS.readdirSync(modules)) {
      if (owner.startsWith(".")) continue;
      const names = owner.startsWith("@")
        ? NodeFS.readdirSync(NodePath.join(modules, owner)).map((name) => `${owner}/${name}`)
        : [owner];
      for (const name of names) {
        const candidate = NodePath.join(modules, name);
        if (!NodeFS.existsSync(candidate)) continue;
        const target = NodeFS.realpathSync(candidate);
        const relative = NodePath.relative(workspaceRoot, target);
        if (
          relative !== ".." &&
          !relative.startsWith(`..${NodePath.sep}`) &&
          !NodePath.isAbsolute(relative)
        ) {
          // A workspace package can resolve different peer slots from the mobile app.
          pending.push(NodePath.join(target, "node_modules"));
          continue;
        }
        if (!stores.some((store) => target.startsWith(`${store}${NodePath.sep}`))) continue;
        const packageBoundary = target.lastIndexOf(`${NodePath.sep}node_modules${NodePath.sep}`);
        if (packageBoundary === -1) continue;
        const slot = target.slice(0, packageBoundary);
        if (slots.has(slot)) continue;
        slots.add(slot);
        pending.push(NodePath.join(slot, "node_modules"));
      }
    }
  }
  return [...slots];
}
