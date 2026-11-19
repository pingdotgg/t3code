// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  GameAsset,
  GameAssetBrief,
  GameAssetCheck,
  GameAssetFile,
  GameAssetImport,
  GameAssetKind,
  GameAssetPublication,
  GameAssetRevision,
  GameAssetStats,
} from "@t3tools/contracts";

import { exists, run, writeJsonAtomic } from "./gameDevFiles.ts";

/**
 * Generated and edited assets for one project, with every revision kept: the editable source
 * (such as a .blend), exports, a preview, the brief it was made for, and the checks it passed.
 * Stored in `<project>/.continuum/assets` so sources live with the project.
 */

const ASSETS_DIR = NodePath.join(".continuum", "assets");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function indexPath(projectRoot: string) {
  return NodePath.join(projectRoot, ASSETS_DIR, "index.json");
}

export async function listAssets(projectRoot: string): Promise<GameAsset[]> {
  const text = await NodeFSP.readFile(indexPath(projectRoot), "utf8").catch(() => null);
  if (text === null) return [];
  try {
    const value = JSON.parse(text) as { assets?: GameAsset[] };
    return Array.isArray(value.assets) ? value.assets : [];
  } catch {
    return [];
  }
}

async function saveAssets(projectRoot: string, assets: ReadonlyArray<GameAsset>) {
  await writeJsonAtomic(indexPath(projectRoot), { version: 1, assets });
  // Keep the token-free asset store committed-friendly but never the work files' temp outputs.
  const ignore = NodePath.join(projectRoot, ".continuum", ".gitignore");
  if (!(await exists(ignore))) await NodeFSP.writeFile(ignore, "bridge.json\nassets/*/work*\n");
}

export function assetIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length >= 2 ? slug : `asset-${NodeCrypto.randomBytes(3).toString("hex")}`;
}

export function assetDir(projectRoot: string, assetId: string): string {
  if (!ID_PATTERN.test(assetId)) throw new Error(`Invalid asset id ${assetId}.`);
  return NodePath.join(projectRoot, ASSETS_DIR, assetId);
}

/** The working .blend agents edit between revisions. */
export function workBlend(projectRoot: string, assetId: string): string {
  return NodePath.join(assetDir(projectRoot, assetId), "work.blend");
}

export async function getAsset(projectRoot: string, assetId: string): Promise<GameAsset | null> {
  return (await listAssets(projectRoot)).find((asset) => asset.assetId === assetId) ?? null;
}

export async function ensureAsset(projectRoot: string, input: { readonly assetId?: string; readonly name: string; readonly kind: GameAssetKind }): Promise<GameAsset> {
  const assets = await listAssets(projectRoot);
  const assetId = input.assetId ?? assetIdFor(input.name);
  const existing = assets.find((asset) => asset.assetId === assetId);
  if (existing) return existing;
  const created: GameAsset = { assetId, name: input.name, kind: input.kind, projectRoot, revisions: [], imports: [], activeRevision: null };
  await NodeFSP.mkdir(assetDir(projectRoot, assetId), { recursive: true });
  await saveAssets(projectRoot, [...assets, created]);
  return created;
}

const FORMAT_OF = (path: string) => NodePath.extname(path).slice(1).toLowerCase() || "file";

export async function addRevision(
  projectRoot: string,
  assetId: string,
  input: {
    readonly createdBy: "agent" | "user";
    readonly tool: GameAssetRevision["tool"];
    readonly note: string;
    readonly files: ReadonlyArray<{ readonly role: GameAssetFile["role"]; readonly source: string }>;
    readonly preview: string | null;
    readonly stats: GameAssetStats;
    readonly checks: ReadonlyArray<GameAssetCheck>;
    readonly brief: GameAssetBrief | null;
    readonly forgeGui: GameAssetRevision["forgeGui"];
    readonly now: Date;
  },
): Promise<{ readonly asset: GameAsset; readonly revision: GameAssetRevision }> {
  const assets = await listAssets(projectRoot);
  const index = assets.findIndex((asset) => asset.assetId === assetId);
  if (index === -1) throw new Error(`No asset ${assetId}.`);
  const asset = assets[index]!;
  const number = (asset.revisions.at(-1)?.revision ?? 0) + 1;
  const folder = NodePath.join(assetDir(projectRoot, assetId), `r${String(number).padStart(3, "0")}`);
  await NodeFSP.mkdir(folder, { recursive: true });
  const files: GameAssetFile[] = [];
  const copy = async (role: GameAssetFile["role"], source: string) => {
    const resolved = NodePath.resolve(projectRoot, source);
    const destination = NodePath.join(folder, `${role === "preview" ? "preview" : NodePath.parse(resolved).name}${NodePath.extname(resolved)}`);
    await NodeFSP.copyFile(resolved, destination);
    const stat = await NodeFSP.stat(destination);
    const entry: GameAssetFile = { role, path: NodePath.relative(projectRoot, destination).split(NodePath.sep).join("/"), format: FORMAT_OF(destination), bytes: stat.size };
    files.push(entry);
    return entry;
  };
  for (const file of input.files) await copy(file.role, file.source);
  const preview = input.preview === null ? null : await copy("preview", input.preview);
  const revision: GameAssetRevision = {
    revision: number,
    createdAt: input.now.toISOString(),
    createdBy: input.createdBy,
    tool: input.tool,
    note: input.note,
    files,
    previewPath: preview?.path ?? null,
    stats: input.stats,
    checks: [...input.checks],
    brief: input.brief ?? asset.revisions.at(-1)?.brief ?? null,
    forgeGui: input.forgeGui,
    publication: null,
  };
  const updated: GameAsset = { ...asset, revisions: [...asset.revisions, revision] };
  assets[index] = updated;
  await saveAssets(projectRoot, assets);
  return { asset: updated, revision };
}

export async function updateAsset(projectRoot: string, assetId: string, update: (asset: GameAsset) => GameAsset): Promise<GameAsset> {
  const assets = await listAssets(projectRoot);
  const index = assets.findIndex((asset) => asset.assetId === assetId);
  if (index === -1) throw new Error(`No asset ${assetId}.`);
  const updated = update(assets[index]!);
  assets[index] = updated;
  await saveAssets(projectRoot, assets);
  return updated;
}

export async function recordImport(projectRoot: string, assetId: string, entry: GameAssetImport): Promise<GameAsset> {
  return updateAsset(projectRoot, assetId, (asset) => ({
    ...asset,
    imports: [...asset.imports, entry].slice(-50),
    activeRevision: entry.status === "imported" ? entry.revision : asset.activeRevision,
  }));
}

export async function recordPublication(projectRoot: string, assetId: string, revision: number, publication: GameAssetPublication): Promise<GameAsset> {
  return updateAsset(projectRoot, assetId, (asset) => ({
    ...asset,
    revisions: asset.revisions.map((entry) => (entry.revision === revision ? { ...entry, publication } : entry)),
  }));
}

export function revisionOf(asset: GameAsset, revision: number): GameAssetRevision {
  const found = asset.revisions.find((entry) => entry.revision === revision);
  if (!found) throw new Error(`${asset.name} has no revision ${revision}.`);
  return found;
}

// Blender -------------------------------------------------------------------------------------

export interface BlenderResult {
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: string | null;
  readonly blenderVersion: string | null;
}

/** Runs one operation from the bundled continuum_blender.py in Blender's background mode. */
export async function runBlender(input: {
  readonly executable: string;
  readonly script: string;
  readonly blend: string | null;
  readonly saveTo: string | null;
  readonly operation: string;
  readonly args: Record<string, unknown>;
  readonly reset: boolean;
  readonly scratchDir: string;
}): Promise<BlenderResult> {
  await NodeFSP.mkdir(input.scratchDir, { recursive: true });
  const stem = NodePath.join(input.scratchDir, `blender-${Date.now().toString(36)}-${NodeCrypto.randomBytes(3).toString("hex")}`);
  const request = `${stem}.request.json`;
  const response = `${stem}.response.json`;
  await NodeFSP.writeFile(request, JSON.stringify({ operation: input.operation, args: input.args, blend: input.saveTo, reset: input.reset }));
  const args = ["--background"];
  if (input.blend !== null && (await exists(input.blend))) args.push(input.blend);
  args.push("--factory-startup", "--python", input.script, "--", request, response);
  const result = await run(input.executable, args, { timeoutMs: 10 * 60_000 });
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(response, "utf8")) as { ok: boolean; value?: unknown; error?: string; blenderVersion?: string };
    return { ok: parsed.ok, value: parsed.value ?? null, error: parsed.error ?? null, blenderVersion: parsed.blenderVersion ?? null };
  } catch {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-12).join("\n");
    return { ok: false, value: null, error: `Blender exited with ${result.code ?? "no code"} without a result.\n${tail}`, blenderVersion: null };
  } finally {
    await NodeFSP.rm(request, { force: true });
    await NodeFSP.rm(response, { force: true });
  }
}

/** Compares what an engine reports after import with what the export promised. */
export function importChecks(input: {
  readonly expected: { readonly x: number; readonly y: number; readonly z: number; readonly units: string } | null;
  readonly measured: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly engineUpAxis: "y" | "z";
  readonly materials: number | null;
  readonly missingTextures: number | null;
  readonly triangles: number | null;
  readonly polygonBudget: number | null;
}): GameAssetCheck[] {
  const checks: GameAssetCheck[] = [];
  if (input.expected && input.measured) {
    const expected = input.expected;
    // Blender is Z-up; Y-up engines swap the vertical axis.
    const wanted = input.engineUpAxis === "y" ? { x: expected.x, y: expected.z, z: expected.y } : expected;
    const sorted = (value: { x: number; y: number; z: number }) => [value.x, value.y, value.z];
    const ratio = Math.max(...sorted(input.measured)) / Math.max(...sorted(wanted), 1e-6);
    const scaleOk = Math.abs(ratio - 1) <= 0.05;
    checks.push({
      name: "Scale in engine",
      status: scaleOk ? "pass" : "fail",
      detail: `Measured ${fmt(input.measured)} ${expected.units}, expected ${fmt(wanted)} ${expected.units}${scaleOk ? "" : ` (off by ×${ratio.toFixed(2)})`}`,
    });
    const verticalMeasured = input.engineUpAxis === "y" ? input.measured.y : input.measured.z;
    const verticalWanted = input.engineUpAxis === "y" ? wanted.y : wanted.z;
    const orientationOk = Math.abs(verticalMeasured - verticalWanted) <= Math.max(0.05 * verticalWanted, 0.01);
    checks.push({
      name: "Orientation (up axis)",
      status: !scaleOk ? "warn" : orientationOk ? "pass" : "fail",
      detail: `Height ${verticalMeasured.toFixed(3)} on the engine's ${input.engineUpAxis.toUpperCase()} axis, expected ${verticalWanted.toFixed(3)}`,
    });
  }
  if (input.materials !== null) {
    const missing = input.missingTextures ?? 0;
    checks.push({
      name: "Materials",
      status: input.materials === 0 ? "warn" : missing > 0 ? "fail" : "pass",
      detail: input.materials === 0 ? "No materials imported" : `${input.materials} material${input.materials === 1 ? "" : "s"}${missing > 0 ? `, ${missing} missing texture${missing === 1 ? "" : "s"}` : ""}`,
    });
  }
  if (input.triangles !== null && input.polygonBudget !== null) {
    checks.push({
      name: "Polygon budget in engine",
      status: input.triangles <= input.polygonBudget ? "pass" : "fail",
      detail: `${input.triangles} triangles, budget ${input.polygonBudget}`,
    });
  }
  return checks;
}

const fmt = (value: { x: number; y: number; z: number }) => `${value.x.toFixed(3)} × ${value.y.toFixed(3)} × ${value.z.toFixed(3)}`;
