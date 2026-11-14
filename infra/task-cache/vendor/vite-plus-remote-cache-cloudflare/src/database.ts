// @effect-diagnostics cryptoRandomUUID:off globalConsole:off - vendored upstream protocol, not an Effect service.
import { HttpError, unavailable } from './errors.ts';
import { GRACE_SECONDS, LEASE_SECONDS } from './limits.ts';
import { measured, type Observations } from './observations.ts';

export interface Scope {
  scope_id: string;
  endpoint: string;
  repository_id: string;
  repository_owner_id: string;
  branch: string;
  policy_version: number;
  writes_enabled: number;
  // 1 when `pull_request` runs whose PR targets `branch` may also publish.
  pull_requests: number;
}
export interface Generation {
  generation_id: string;
  scope_id: string;
  value_object: string;
  blob_object: string;
  blob_id: string | null;
  value_size: number;
  blob_size: number;
}
export interface Selection extends Generation {
  kind: 'exact' | 'fallback';
  key: number[];
}

// Preserve empty and non-UTF-8 keys as BLOBs, without text or hash conversions.
export function binary(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function getScope(db: D1Database, id: string, stats?: Observations): Promise<Scope> {
  let scope: Scope | null;
  try {
    const { results } = await measured(
      db
        .prepare(`SELECT s.*, (s.writes_enabled AND d.writes_enabled) AS writes_enabled
      FROM scopes s, deployment d WHERE s.scope_id = ? AND s.enabled = 1 AND d.enabled = 1`)
        .bind(id)
        .all<Scope>(),
      stats,
    );
    scope = results[0] ?? null;
  } catch {
    unavailable();
  }
  if (!scope) throw new HttpError(404, 'unknown_scope');
  return scope;
}

export async function selectEntry(
  db: D1Database,
  scope: string,
  key: Uint8Array,
  secondary: Uint8Array,
  stats?: Observations,
): Promise<Selection | null> {
  // Both branches use indexed identities in one SQLite snapshot.
  try {
    const { results } = await measured(
      db
        .prepare(`
      SELECT g.*, e.key, 'exact' AS kind, 0 AS priority
      FROM entries e JOIN generations g ON g.generation_id = e.generation_id
      JOIN scopes s ON s.scope_id = e.scope_id CROSS JOIN deployment d
      WHERE e.scope_id = ?1 AND e.key = ?2 AND g.state = 'ready' AND g.expires_at > unixepoch()
        AND s.enabled = 1 AND d.enabled = 1
      UNION ALL
      SELECT g.*, e.key, 'fallback' AS kind, 1 AS priority
      FROM associations a JOIN entries e ON e.scope_id = a.scope_id AND e.key = a.target_key
      JOIN generations g ON g.generation_id = e.generation_id
      JOIN scopes s ON s.scope_id = e.scope_id CROSS JOIN deployment d
      WHERE a.scope_id = ?1 AND a.secondary_key = ?3 AND g.state = 'ready' AND g.expires_at > unixepoch()
        AND s.enabled = 1 AND d.enabled = 1
      ORDER BY priority LIMIT 1`)
        .bind(scope, binary(key), binary(secondary))
        .all<Selection>(),
      stats,
    );
    return results[0] ?? null;
  } catch {
    unavailable();
  }
}

export async function selectBlob(
  db: D1Database,
  scope: string,
  blob: string,
  stats?: Observations,
): Promise<Generation | null> {
  try {
    const { results } = await measured(
      db
        .prepare(`SELECT g.* FROM generations g JOIN scopes s ON s.scope_id = g.scope_id CROSS JOIN deployment d
      WHERE g.scope_id = ? AND g.blob_id = ? AND s.enabled = 1 AND d.enabled = 1
        AND ((g.state = 'ready' AND g.expires_at > unixepoch()) OR (g.state = 'retired' AND g.gc_after > unixepoch()))`)
        .bind(scope, blob)
        .all<Generation>(),
      stats,
    );
    return results[0] ?? null;
  } catch {
    unavailable();
  }
}

export async function reserve(
  db: D1Database,
  scope: Scope,
  tokenExp: number,
  bytes: number,
  stats?: Observations,
): Promise<Generation> {
  const id = crypto.randomUUID();
  const prefix = `${scope.scope_id}/${id}`;
  try {
    await measured(
      db
        .prepare(`INSERT INTO generations
      (generation_id, scope_id, state, policy_version, token_exp, lease_until, gc_after, value_object, blob_object, charged_bytes)
      VALUES (?, ?, 'uploading', ?, ?, unixepoch() + ?, unixepoch() + ?, ?, ?, ?)`)
        .bind(
          id,
          scope.scope_id,
          scope.policy_version,
          tokenExp,
          LEASE_SECONDS,
          LEASE_SECONDS + GRACE_SECONDS,
          `${prefix}/value`,
          `${prefix}/blob`,
          bytes,
        )
        .run(),
      stats,
    );
  } catch {
    unavailable();
  }
  return {
    generation_id: id,
    scope_id: scope.scope_id,
    value_object: `${prefix}/value`,
    blob_object: `${prefix}/blob`,
    blob_id: null,
    value_size: 0,
    blob_size: 0,
  };
}

export async function recordMultipart(
  db: D1Database,
  generation: Generation,
  uploadId: string,
  stats?: Observations,
): Promise<void> {
  const result = await measured(
    db
      .prepare(
        `UPDATE generations SET upload_id = ? WHERE generation_id = ? AND state = 'uploading' AND lease_until > unixepoch()`,
      )
      .bind(uploadId, generation.generation_id)
      .run(),
    stats,
  );
  if (result.meta.changes !== 1) unavailable();
}

export async function publish(
  db: D1Database,
  generation: Generation,
  key: Uint8Array,
  secondary: Uint8Array,
  stats?: Observations,
): Promise<void> {
  const actual = generation.value_size + generation.blob_size;
  let results: D1Result[];
  try {
    results = await measured(
      db.batch([
        db
          .prepare(`UPDATE generations SET state = 'ready', key = ?, secondary_key = ?, blob_id = ?,
      value_size = ?, blob_size = ?, charged_bytes = ?,
      expires_at = unixepoch() + (SELECT retention_seconds FROM scopes WHERE scope_id = generations.scope_id),
      gc_after = unixepoch() + (SELECT retention_seconds FROM scopes WHERE scope_id = generations.scope_id)
      WHERE generation_id = ? AND state = 'uploading' AND lease_until > unixepoch() AND token_exp > unixepoch()
        AND charged_bytes >= ? AND EXISTS (
          SELECT 1 FROM scopes s, deployment d WHERE s.scope_id = generations.scope_id
            AND s.policy_version = generations.policy_version AND s.enabled = 1 AND s.writes_enabled = 1
            AND d.enabled = 1 AND d.writes_enabled = 1 AND s.charged_bytes <= s.byte_limit AND d.charged_bytes <= d.byte_limit
        ) RETURNING generation_id`)
          .bind(
            binary(key),
            binary(secondary),
            generation.blob_id,
            generation.value_size,
            generation.blob_size,
            actual,
            generation.generation_id,
            actual,
          ),
      ]),
      stats,
    );
  } catch {
    unavailable();
  }
  if (results[0]?.results.length !== 1) throw new HttpError(503, 'publication_guard');
}

export async function abandon(db: D1Database, id: string): Promise<void> {
  // Keep charges during the grace period for R2 operations that finish late.
  await db
    .prepare(`UPDATE generations SET lease_until = min(lease_until, unixepoch()), gc_after = min(gc_after, unixepoch() + ?)
    WHERE generation_id = ? AND state = 'uploading'`)
    .bind(GRACE_SECONDS, id)
    .run();
}

export async function cleanup(env: Env): Promise<void> {
  const limit = Number(env.GC_BATCH_SIZE);
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw new Error('Invalid GC batch size');
  const claim = crypto.randomUUID();
  const claimed =
    await env.INDEX.prepare(`UPDATE generations SET state = 'deleting', gc_claim = ?, gc_after = unixepoch() + 600
    WHERE generation_id IN (SELECT generation_id FROM generations WHERE gc_after <= unixepoch() ORDER BY gc_after LIMIT ?)
    RETURNING generation_id, value_object, blob_object, upload_id`)
      .bind(claim, limit)
      .all<{
        generation_id: string;
        value_object: string;
        blob_object: string;
        upload_id: string | null;
      }>();
  let deleted = 0;
  for (const generation of claimed.results) {
    try {
      if (generation.upload_id)
        await env.ARTIFACTS.resumeMultipartUpload(
          generation.blob_object,
          generation.upload_id,
        ).abort();
      await env.ARTIFACTS.delete([generation.value_object, generation.blob_object]);
      // FK deletion only removes entries still selecting this generation.
      await env.INDEX.prepare(
        `DELETE FROM generations WHERE generation_id = ? AND state = 'deleting' AND gc_claim = ?`,
      )
        .bind(generation.generation_id, claim)
        .run();
      deleted++;
    } catch {
      console.warn(
        JSON.stringify({
          operation: 'cleanup',
          error: 'deletion_failed',
          generation: generation.generation_id,
        }),
      );
    }
  }
  await cleanAssociations(env.INDEX, limit);
  console.log(JSON.stringify({ operation: 'cleanup', claimed: claimed.results.length, deleted }));
}

async function cleanAssociations(db: D1Database, limit: number): Promise<void> {
  // Cursor bounds scanning as well as deletion, even when all associations are live.
  const batch = await db
    .prepare(`SELECT scope_id, secondary_key FROM associations
    WHERE (scope_id, secondary_key) > (SELECT scope_id, secondary_key FROM maintenance WHERE id = 1)
    ORDER BY scope_id, secondary_key LIMIT ?`)
    .bind(limit)
    .all<{ scope_id: string; secondary_key: number[] }>();
  const last = batch.results.at(-1);
  await db.batch([
    db
      .prepare(`DELETE FROM associations WHERE (scope_id, secondary_key) IN (
      SELECT scope_id, secondary_key FROM associations
      WHERE (scope_id, secondary_key) > (SELECT scope_id, secondary_key FROM maintenance WHERE id = 1)
      ORDER BY scope_id, secondary_key LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.scope_id = associations.scope_id AND e.key = associations.target_key)`)
      .bind(limit),
    db
      .prepare('UPDATE maintenance SET scope_id = ?, secondary_key = ? WHERE id = 1')
      .bind(last?.scope_id ?? '', binary(new Uint8Array(last?.secondary_key ?? []))),
  ]);
}
