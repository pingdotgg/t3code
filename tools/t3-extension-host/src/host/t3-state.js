'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const RECENT_RUN_MS = 2 * 60 * 1000;
const THREAD_CACHE_MS = 30 * 1000;

function countLines(text) {
  return text ? text.split(/\r\n|\r|\n/).length : 0;
}

function unifiedDiffStats(diff) {
  let added = 0;
  let removed = 0;
  let line;
  let inHunk = false;
  for (const row of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) {
      inHunk = true;
      line ??= Math.max(0, Number(hunk[1]) - 1);
    } else if (inHunk && row.startsWith('+')) {
      added++;
    } else if (inHunk && row.startsWith('-')) {
      removed++;
    }
  }
  return inHunk ? { delta: added - removed, line } : {};
}

function lineStats(payload) {
  if (typeof payload.newStr === 'string') {
    if (typeof payload.oldStr !== 'string') return { created: true };
    return { delta: countLines(payload.newStr) - countLines(payload.oldStr), snippet: payload.newStr };
  }
  if (typeof payload.diffStr !== 'string') return {};
  if (payload.diffStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(payload.diffStr);
      if (typeof parsed.newString === 'string') {
        return { delta: countLines(parsed.newString) - countLines(parsed.oldString ?? ''), snippet: parsed.newString };
      }
      if (typeof parsed.content === 'string') return { created: true };
    } catch {}
  }
  return unifiedDiffStats(payload.diffStr);
}

function describeFileChange(payload, root) {
  const paths = [];
  if (Array.isArray(payload.changes)) {
    for (const change of payload.changes) {
      if (change && typeof change.path === 'string' && change.operation !== 'delete') paths.push(change.path);
    }
  }
  if (!paths.length && typeof payload.fileName === 'string') paths.push(payload.fileName);
  return paths.map((p, index) => ({
    path: root && !path.isAbsolute(p) ? path.resolve(root, p) : path.resolve(p),
    ...(index === 0 ? lineStats(payload) : {}),
  }));
}

const REQUIRED_SCHEMA = {
  orchestration_v2_projection_runs: ['run_id', 'thread_id', 'status', 'requested_at', 'completed_at', 'payload_json'],
  orchestration_v2_projection_turn_items: ['turn_item_id', 'thread_id', 'run_id', 'type', 'status', 'payload_json'],
  orchestration_v2_projection_threads: ['thread_id', 'project_id', 'title', 'payload_json', 'deleted_at', 'archived_at'],
  projection_projects: ['project_id', 'title', 'workspace_root'],
};

function missingSchema(db) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const present = new Set(db.prepare('select name from pragma_table_info(?)').all(table).map((row) => row.name));
    if (!present.size) missing.push(table);
    else for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}

function hasColumns(db, table, columns) {
  const present = new Set(db.prepare('select name from pragma_table_info(?)').all(table).map((row) => row.name));
  return columns.every((column) => present.has(column));
}

class T3State {
  constructor({ t3Home, logger }) {
    this.dbPath = path.join(t3Home, 'userdata', 'statev2.sqlite');
    this.logger = logger;
    this.db = null;
    this.seenByRun = new Map();
    this.threads = new Map();
    this.primed = false;
  }

  open() {
    const db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 250 });
    try {
      const missing = missingSchema(db);
      if (missing.length) throw new Error(`T3 Code's database layout changed (missing ${missing.join(', ')}); update t3-extension-host`);
      this.queries = this.prepare(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    this.dataVersion = null;
  }

  prepare(db) {
    return {
      dataVersion: db.prepare('pragma data_version'),
      runs: db.prepare(`
        select run_id, thread_id, status,
          json_extract(payload_json, '$.modelSelection.model') as model,
          json_extract(payload_json, '$.providerInstanceId') as provider
        from orchestration_v2_projection_runs
        where status in ('running', 'queued') or completed_at >= ?
        order by requested_at desc`),
      waiting: hasColumns(db, 'orchestration_v2_projection_runtime_requests', ['thread_id', 'status', 'resolved_at'])
        ? db.prepare(`
            select distinct thread_id from orchestration_v2_projection_runtime_requests
            where resolved_at is null and status not in ('resolved', 'cancelled', 'failed', 'expired', 'rejected', 'interrupted')`)
        : null,
      itemIds: db.prepare(`
        select turn_item_id from orchestration_v2_projection_turn_items
        where thread_id = ? and run_id = ? and type = 'file_change' and status = 'completed'`),
      item: db.prepare('select payload_json from orchestration_v2_projection_turn_items where turn_item_id = ?'),
      thread: db.prepare(`
        select t.title, t.payload_json, p.title as project_title, p.workspace_root
        from orchestration_v2_projection_threads t
        left join projection_projects p on p.project_id = t.project_id
        where t.thread_id = ?`),
      lastVisited: db.prepare(`
        select thread_id from orchestration_v2_projection_threads
        where deleted_at is null and archived_at is null
        order by json_extract(payload_json, '$.lastVisitedAt') desc limit 1`),
    };
  }

  close() {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  thread(threadId) {
    const cached = this.threads.get(threadId);
    if (cached && Date.now() - cached.at < THREAD_CACHE_MS) return cached.info;
    const row = this.queries.thread.get(threadId);
    if (!row) return null;
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {}
    const projectRoot = row.workspace_root || null;
    const root = payload.worktreePath || projectRoot;
    const info = {
      threadId,
      title: row.title,
      projectTitle: row.project_title || (root ? path.basename(root) : 'T3 Code'),
      root,
      projectRoot,
    };
    this.threads.set(threadId, { info, at: Date.now() });
    return info;
  }

  poll() {
    if (!this.db) this.open();
    try {
      return this.read();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read() {
    const version = this.queries.dataVersion.get()?.data_version;
    if (this.last && version === this.dataVersion) return { ...this.last, edits: [] };
    const runs = this.queries.runs.all(new Date(Date.now() - RECENT_RUN_MS).toISOString());
    const running = runs.filter((run) => run.status === 'running' || run.status === 'queued');
    const runIds = new Set();
    const edits = [];

    for (const run of runs) {
      runIds.add(run.run_id);
      let seen = this.seenByRun.get(run.run_id);
      if (!seen) {
        seen = new Set();
        this.seenByRun.set(run.run_id, seen);
      }
      for (const { turn_item_id: itemId } of this.queries.itemIds.all(run.thread_id, run.run_id)) {
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        if (!this.primed) continue;
        const thread = this.thread(run.thread_id);
        const row = this.queries.item.get(itemId);
        if (!thread || !row) continue;
        try {
          edits.push({ thread, files: describeFileChange(JSON.parse(row.payload_json), thread.root) });
        } catch (error) {
          this.logger.debug(`Skipping unreadable file change ${itemId}: ${error.message}`);
        }
      }
    }
    for (const runId of this.seenByRun.keys()) {
      if (!runIds.has(runId)) this.seenByRun.delete(runId);
    }
    this.primed = true;

    const runningThreadIds = new Set(running.map((run) => run.thread_id));
    const agents = new Map();
    for (const run of running) {
      if (!agents.has(run.thread_id)) agents.set(run.thread_id, { model: run.model ?? null, provider: run.provider ?? null });
    }
    const waitingThreadIds = new Set((this.queries.waiting?.all() ?? []).map((row) => row.thread_id).filter((id) => runningThreadIds.has(id)));
    const visited = this.queries.lastVisited.get()?.thread_id;
    const focusId = visited && runningThreadIds.has(visited) ? visited : (running[0]?.thread_id ?? visited);
    this.last = { focus: focusId ? this.thread(focusId) : null, runningThreadIds, waitingThreadIds, agents };
    this.dataVersion = version;
    return { ...this.last, edits };
  }
}

module.exports = { T3State, describeFileChange, countLines };
