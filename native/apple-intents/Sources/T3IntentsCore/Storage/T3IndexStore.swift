import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public enum T3IndexStoreError: Error, Sendable {
  case openFailed(String)
  case statementFailed(String)
}

/// Thread-safe WAL SQLite store shared via App Group container between host app and App Intents extension.
public final class T3IndexStore: @unchecked Sendable {
  public static let shared = T3IndexStore(databaseURL: T3IntentsConfig.indexDatabaseURL)

  private let databaseURL: URL
  private let queue = DispatchQueue(label: "com.t3tools.t3code.apple-intents.store")
  private var db: OpaquePointer?

  public init(databaseURL: URL) {
    self.databaseURL = databaseURL
  }

  deinit {
    if let handle = db {
      sqlite3_close(handle)
    }
  }

  private func ensureOpen() throws -> OpaquePointer {
    if let existing = db {
      return existing
    }
    let parent = databaseURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

    var handle: OpaquePointer?
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    let rc = sqlite3_open_v2(databaseURL.path, &handle, flags, nil)
    guard rc == SQLITE_OK, let opened = handle else {
      let message = handle.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 failed (\(rc))"
      if let handle { sqlite3_close(handle) }
      throw T3IndexStoreError.openFailed(message)
    }

    sqlite3_busy_timeout(opened, 5_000)
    try exec(opened, sql: """
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        http_base_url TEXT,
        is_local INTEGER NOT NULL,
        is_connected INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        environment_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        repository_identity TEXT,
        branch TEXT,
        updated_at TEXT NOT NULL,
        deep_link_url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_env ON projects(environment_id);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY NOT NULL,
        environment_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT,
        status TEXT NOT NULL,
        has_pending_request INTEGER NOT NULL,
        pending_request_summary TEXT,
        is_pinned INTEGER NOT NULL,
        is_settled INTEGER NOT NULL,
        is_snoozed INTEGER NOT NULL,
        snoozed_until TEXT,
        last_message_preview TEXT,
        provider_label TEXT,
        model_label TEXT,
        updated_at TEXT NOT NULL,
        deep_link_url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_env ON threads(environment_id);
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
      """)
    db = opened
    return opened
  }

  private func exec(_ handle: OpaquePointer, sql: String) throws {
    var errPtr: UnsafeMutablePointer<CChar>?
    let rc = sqlite3_exec(handle, sql, nil, nil, &errPtr)
    if rc != SQLITE_OK {
      let message = errPtr.map { String(cString: $0) } ?? "SQLite error \(rc)"
      sqlite3_free(errPtr)
      throw T3IndexStoreError.statementFailed(message)
    }
  }

  private func bindText(_ stmt: OpaquePointer, index: Int32, value: String?) {
    if let value {
      sqlite3_bind_text(stmt, index, value, -1, sqliteTransient)
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }

  private func columnText(_ stmt: OpaquePointer, index: Int32) -> String? {
    guard let ptr = sqlite3_column_text(stmt, index) else { return nil }
    return String(cString: ptr)
  }

  public func applyDelta(_ delta: T3IndexDelta) throws -> T3SpotlightDiff {
    try queue.sync {
      let handle = try ensureOpen()
      try exec(handle, sql: "BEGIN IMMEDIATE;")
      do {
        var removedProjectIds = Set(delta.removedProjectIds)
        var removedThreadIds = Set(delta.removedThreadIds)

        for envId in delta.removedEnvironmentIds {
          for project in try queryProjects(handle, whereClause: "environment_id = ?", bindings: [envId]) {
            removedProjectIds.insert(project.id)
          }
          for thread in try queryThreads(handle, whereClause: "environment_id = ?", bindings: [envId]) {
            removedThreadIds.insert(thread.id)
          }
          try runDelete(handle, sql: "DELETE FROM threads WHERE environment_id = ?;", binding: envId)
          try runDelete(handle, sql: "DELETE FROM projects WHERE environment_id = ?;", binding: envId)
          try runDelete(handle, sql: "DELETE FROM environments WHERE id = ?;", binding: envId)
        }

        for env in delta.environments {
          try upsertEnvironment(handle, env)
        }

        for projectId in delta.removedProjectIds {
          try runDelete(handle, sql: "DELETE FROM projects WHERE id = ?;", binding: projectId)
        }
        for project in delta.upsertedProjects {
          try upsertProject(handle, project)
        }

        for threadId in delta.removedThreadIds {
          try runDelete(handle, sql: "DELETE FROM threads WHERE id = ?;", binding: threadId)
        }
        for thread in delta.upsertedThreads {
          try upsertThread(handle, thread)
        }

        try exec(handle, sql: "COMMIT;")
        return T3SpotlightDiff(
          upsertedProjects: delta.upsertedProjects,
          removedProjectIds: Array(removedProjectIds),
          upsertedThreads: delta.upsertedThreads,
          removedThreadIds: Array(removedThreadIds)
        )
      } catch {
        try? exec(handle, sql: "ROLLBACK;")
        throw error
      }
    }
  }

  public func removeEnvironment(environmentId: String) throws -> T3SpotlightDiff {
    try applyDelta(T3IndexDelta(removedEnvironmentIds: [environmentId]))
  }

  public func clearAll() throws {
    try queue.sync {
      let handle = try ensureOpen()
      try exec(handle, sql: """
        BEGIN IMMEDIATE;
        DELETE FROM threads;
        DELETE FROM projects;
        DELETE FROM environments;
        COMMIT;
        """)
    }
  }

  public func allEnvironments() -> [T3EnvironmentRecord] {
    queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      return (try? queryEnvironments(handle, whereClause: nil, bindings: [])) ?? []
    }
  }

  public func environments(for ids: [String]) -> [T3EnvironmentRecord] {
    guard !ids.isEmpty else { return [] }
    return queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      return (try? queryEnvironments(handle, whereClause: "id IN (\(placeholders))", bindings: ids)) ?? []
    }
  }

  public func environment(id: String) -> T3EnvironmentRecord? {
    environments(for: [id]).first
  }

  public func allProjects() -> [T3ProjectRecord] {
    queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      return (try? queryProjects(handle, whereClause: nil, bindings: [])) ?? []
    }
  }

  public func projects(for ids: [String]) -> [T3ProjectRecord] {
    guard !ids.isEmpty else { return [] }
    return queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      return (try? queryProjects(handle, whereClause: "id IN (\(placeholders))", bindings: ids)) ?? []
    }
  }

  public func searchProjects(matching query: String) -> [T3ProjectRecord] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return allProjects() }
    let pattern = "%\(trimmed)%"
    return queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      return (try? queryProjects(
        handle,
        whereClause: "name LIKE ? COLLATE NOCASE OR workspace_root LIKE ? COLLATE NOCASE OR COALESCE(repository_identity, '') LIKE ? COLLATE NOCASE",
        bindings: [pattern, pattern, pattern]
      )) ?? []
    }
  }

  public func allThreads(limit: Int = 500) -> [T3ThreadRecord] {
    queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      return (try? queryThreads(handle, whereClause: nil, bindings: [], limit: limit)) ?? []
    }
  }

  public func threads(for ids: [String]) -> [T3ThreadRecord] {
    guard !ids.isEmpty else { return [] }
    return queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      return (try? queryThreads(handle, whereClause: "id IN (\(placeholders))", bindings: ids, limit: ids.count)) ?? []
    }
  }

  public func thread(id: String) -> T3ThreadRecord? {
    threads(for: [id]).first
  }

  public func searchThreads(matching query: String, limit: Int = 50) -> [T3ThreadRecord] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return allThreads(limit: limit) }
    let pattern = "%\(trimmed)%"
    return queue.sync {
      guard let handle = try? ensureOpen() else { return [] }
      return (try? queryThreads(
        handle,
        whereClause: "title LIKE ? COLLATE NOCASE OR project_name LIKE ? COLLATE NOCASE OR COALESCE(branch, '') LIKE ? COLLATE NOCASE",
        bindings: [pattern, pattern, pattern],
        limit: limit
      )) ?? []
    }
  }

  public func upsertThreadRecord(_ thread: T3ThreadRecord) throws {
    try queue.sync {
      let handle = try ensureOpen()
      try upsertThread(handle, thread)
    }
  }

  public func deleteThreadRecord(id: String) throws {
    try queue.sync {
      let handle = try ensureOpen()
      try runDelete(handle, sql: "DELETE FROM threads WHERE id = ?;", binding: id)
    }
  }

  private func runDelete(_ handle: OpaquePointer, sql: String, binding: String) throws {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, index: 1, value: binding)
    guard sqlite3_step(stmt) == SQLITE_DONE else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
  }

  private func upsertEnvironment(_ handle: OpaquePointer, _ env: T3EnvironmentRecord) throws {
    let sql = """
      INSERT INTO environments (id, label, http_base_url, is_local, is_connected, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        http_base_url = excluded.http_base_url,
        is_local = excluded.is_local,
        is_connected = excluded.is_connected,
        updated_at = excluded.updated_at;
      """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, index: 1, value: env.id)
    bindText(stmt, index: 2, value: env.label)
    bindText(stmt, index: 3, value: env.httpBaseUrl)
    sqlite3_bind_int(stmt, 4, env.isLocal ? 1 : 0)
    sqlite3_bind_int(stmt, 5, env.isConnected ? 1 : 0)
    bindText(stmt, index: 6, value: env.updatedAt)
    guard sqlite3_step(stmt) == SQLITE_DONE else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
  }

  private func upsertProject(_ handle: OpaquePointer, _ project: T3ProjectRecord) throws {
    let sql = """
      INSERT INTO projects (
        id, environment_id, project_id, name, workspace_root, repository_identity, branch, updated_at, deep_link_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        environment_id = excluded.environment_id,
        project_id = excluded.project_id,
        name = excluded.name,
        workspace_root = excluded.workspace_root,
        repository_identity = excluded.repository_identity,
        branch = excluded.branch,
        updated_at = excluded.updated_at,
        deep_link_url = excluded.deep_link_url;
      """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, index: 1, value: project.id)
    bindText(stmt, index: 2, value: project.environmentId)
    bindText(stmt, index: 3, value: project.projectId)
    bindText(stmt, index: 4, value: project.name)
    bindText(stmt, index: 5, value: project.workspaceRoot)
    bindText(stmt, index: 6, value: project.repositoryIdentity)
    bindText(stmt, index: 7, value: project.branch)
    bindText(stmt, index: 8, value: project.updatedAt)
    bindText(stmt, index: 9, value: project.deepLinkUrl)
    guard sqlite3_step(stmt) == SQLITE_DONE else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
  }

  private func upsertThread(_ handle: OpaquePointer, _ thread: T3ThreadRecord) throws {
    let sql = """
      INSERT INTO threads (
        id, environment_id, thread_id, project_id, project_name, title, branch, status,
        has_pending_request, pending_request_summary, is_pinned, is_settled, is_snoozed,
        snoozed_until, last_message_preview, provider_label, model_label, updated_at, deep_link_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        environment_id = excluded.environment_id,
        thread_id = excluded.thread_id,
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        title = excluded.title,
        branch = excluded.branch,
        status = excluded.status,
        has_pending_request = excluded.has_pending_request,
        pending_request_summary = excluded.pending_request_summary,
        is_pinned = excluded.is_pinned,
        is_settled = excluded.is_settled,
        is_snoozed = excluded.is_snoozed,
        snoozed_until = excluded.snoozed_until,
        last_message_preview = excluded.last_message_preview,
        provider_label = excluded.provider_label,
        model_label = excluded.model_label,
        updated_at = excluded.updated_at,
        deep_link_url = excluded.deep_link_url;
      """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, index: 1, value: thread.id)
    bindText(stmt, index: 2, value: thread.environmentId)
    bindText(stmt, index: 3, value: thread.threadId)
    bindText(stmt, index: 4, value: thread.projectId)
    bindText(stmt, index: 5, value: thread.projectName)
    bindText(stmt, index: 6, value: thread.title)
    bindText(stmt, index: 7, value: thread.branch)
    bindText(stmt, index: 8, value: thread.status)
    sqlite3_bind_int(stmt, 9, thread.hasPendingRequest ? 1 : 0)
    bindText(stmt, index: 10, value: thread.pendingRequestSummary)
    sqlite3_bind_int(stmt, 11, thread.isPinned ? 1 : 0)
    sqlite3_bind_int(stmt, 12, thread.isSettled ? 1 : 0)
    sqlite3_bind_int(stmt, 13, thread.isSnoozed ? 1 : 0)
    bindText(stmt, index: 14, value: thread.snoozedUntil)
    bindText(stmt, index: 15, value: thread.lastMessagePreview)
    bindText(stmt, index: 16, value: thread.providerLabel)
    bindText(stmt, index: 17, value: thread.modelLabel)
    bindText(stmt, index: 18, value: thread.updatedAt)
    bindText(stmt, index: 19, value: thread.deepLinkUrl)
    guard sqlite3_step(stmt) == SQLITE_DONE else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
  }

  private func queryEnvironments(
    _ handle: OpaquePointer,
    whereClause: String?,
    bindings: [String]
  ) throws -> [T3EnvironmentRecord] {
    var sql = "SELECT id, label, http_base_url, is_local, is_connected, updated_at FROM environments"
    if let whereClause { sql += " WHERE \(whereClause)" }
    sql += " ORDER BY is_local DESC, label ASC;"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    for (idx, value) in bindings.enumerated() {
      bindText(stmt, index: Int32(idx + 1), value: value)
    }
    var rows: [T3EnvironmentRecord] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      rows.append(
        T3EnvironmentRecord(
          id: columnText(stmt, index: 0) ?? "",
          label: columnText(stmt, index: 1) ?? "",
          httpBaseUrl: columnText(stmt, index: 2),
          isLocal: sqlite3_column_int(stmt, 3) != 0,
          isConnected: sqlite3_column_int(stmt, 4) != 0,
          updatedAt: columnText(stmt, index: 5) ?? ""
        )
      )
    }
    return rows
  }

  private func queryProjects(
    _ handle: OpaquePointer,
    whereClause: String?,
    bindings: [String]
  ) throws -> [T3ProjectRecord] {
    var sql = """
      SELECT id, environment_id, project_id, name, workspace_root, repository_identity, branch, updated_at, deep_link_url
      FROM projects
      """
    if let whereClause { sql += " WHERE \(whereClause)" }
    sql += " ORDER BY updated_at DESC, name ASC;"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    for (idx, value) in bindings.enumerated() {
      bindText(stmt, index: Int32(idx + 1), value: value)
    }
    var rows: [T3ProjectRecord] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      rows.append(
        T3ProjectRecord(
          id: columnText(stmt, index: 0) ?? "",
          environmentId: columnText(stmt, index: 1) ?? "",
          projectId: columnText(stmt, index: 2) ?? "",
          name: columnText(stmt, index: 3) ?? "",
          workspaceRoot: columnText(stmt, index: 4) ?? "",
          repositoryIdentity: columnText(stmt, index: 5),
          branch: columnText(stmt, index: 6),
          updatedAt: columnText(stmt, index: 7) ?? "",
          deepLinkUrl: columnText(stmt, index: 8) ?? ""
        )
      )
    }
    return rows
  }

  private func queryThreads(
    _ handle: OpaquePointer,
    whereClause: String?,
    bindings: [String],
    limit: Int = 500
  ) throws -> [T3ThreadRecord] {
    var sql = """
      SELECT id, environment_id, thread_id, project_id, project_name, title, branch, status,
             has_pending_request, pending_request_summary, is_pinned, is_settled, is_snoozed,
             snoozed_until, last_message_preview, provider_label, model_label, updated_at, deep_link_url
      FROM threads
      """
    if let whereClause { sql += " WHERE \(whereClause)" }
    sql += " ORDER BY has_pending_request DESC, is_pinned DESC, updated_at DESC LIMIT \(max(1, limit));"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw T3IndexStoreError.statementFailed(String(cString: sqlite3_errmsg(handle)))
    }
    defer { sqlite3_finalize(stmt) }
    for (idx, value) in bindings.enumerated() {
      bindText(stmt, index: Int32(idx + 1), value: value)
    }
    var rows: [T3ThreadRecord] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      rows.append(
        T3ThreadRecord(
          id: columnText(stmt, index: 0) ?? "",
          environmentId: columnText(stmt, index: 1) ?? "",
          threadId: columnText(stmt, index: 2) ?? "",
          projectId: columnText(stmt, index: 3) ?? "",
          projectName: columnText(stmt, index: 4) ?? "",
          title: columnText(stmt, index: 5) ?? "",
          branch: columnText(stmt, index: 6),
          status: columnText(stmt, index: 7) ?? "idle",
          hasPendingRequest: sqlite3_column_int(stmt, 8) != 0,
          pendingRequestSummary: columnText(stmt, index: 9),
          isPinned: sqlite3_column_int(stmt, 10) != 0,
          isSettled: sqlite3_column_int(stmt, 11) != 0,
          isSnoozed: sqlite3_column_int(stmt, 12) != 0,
          snoozedUntil: columnText(stmt, index: 13),
          lastMessagePreview: columnText(stmt, index: 14),
          providerLabel: columnText(stmt, index: 15),
          modelLabel: columnText(stmt, index: 16),
          updatedAt: columnText(stmt, index: 17) ?? "",
          deepLinkUrl: columnText(stmt, index: 18) ?? ""
        )
      )
    }
    return rows
  }
}
