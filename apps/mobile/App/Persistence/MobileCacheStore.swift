import Foundation
import SQLite3
import T3MobileProtocol

final class MobileCacheStore: @unchecked Sendable {
    static let schemaVersion: Int32 = 1
    static let shellSnapshotSchemaVersion = 1
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let lock = NSLock()
    private var database: OpaquePointer?

    init(databaseURL: URL) throws {
        var openedDatabase: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(databaseURL.path, &openedDatabase, flags, nil) != SQLITE_OK {
            let message = openedDatabase.map(Self.errorMessage) ?? "unknown SQLite open failure"
            if let openedDatabase {
                sqlite3_close(openedDatabase)
            }
            throw MobileCacheError.openFailed(message)
        }
        database = openedDatabase
        try migrate()
    }

    deinit {
        if let database {
            sqlite3_close(database)
        }
    }

    static func appStore(fileManager: FileManager = .default) throws -> MobileCacheStore {
        let appSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = appSupport.appendingPathComponent("T3Mobile", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return try MobileCacheStore(databaseURL: directory.appendingPathComponent("mobile-cache.sqlite3"))
    }

    func loadShell() throws -> MobileCachedShell? {
        try locked {
        let rows = try query(
            """
            SELECT environment_json, shell_json, protocol_version, snapshot_schema_version, saved_at
            FROM shell_cache
            WHERE id = 1
            LIMIT 1
            """,
            bindings: []
        )
        guard let row = rows.first else {
            return nil
        }
        let environment = try decoder.decode(MobileEnvironment.self, from: Data(try text(row, "environment_json").utf8))
        let shellState = try decoder.decode(MobileShellState.self, from: Data(try text(row, "shell_json").utf8))
        return MobileCachedShell(
            environment: environment,
            shellState: shellState,
            protocolVersion: try text(row, "protocol_version"),
            snapshotSchemaVersion: Int(try text(row, "snapshot_schema_version")) ?? 0,
            savedAt: try text(row, "saved_at")
        )
        }
    }

    func saveInitialSync(_ result: MobileInitialSyncResult) throws {
        try locked {
            try saveShellUnlocked(environment: result.environment, shellState: result.shellState)
        }
    }

    func saveShell(environment: MobileEnvironment, shellState: MobileShellState) throws {
        try locked {
            try saveShellUnlocked(environment: environment, shellState: shellState)
        }
    }

    func saveThreadSnapshot(threadID: String, snapshotJSON: Data, snapshotSequence: Int) throws {
        try locked {
            try saveThreadSnapshotUnlocked(
                threadID: threadID,
                snapshotJSON: snapshotJSON,
                snapshotSequence: snapshotSequence
            )
        }
    }

    func saveThreadSnapshotAndCursor(threadID: String, snapshotJSON: Data, snapshotSequence: Int) throws {
        try locked {
            try execute("BEGIN IMMEDIATE", bindings: [])
            do {
                try saveThreadSnapshotUnlocked(
                    threadID: threadID,
                    snapshotJSON: snapshotJSON,
                    snapshotSequence: snapshotSequence
                )
                try saveEventCursorUnlocked(name: "thread:\(threadID)", sequence: snapshotSequence)
                try execute("COMMIT", bindings: [])
            } catch {
                try? execute("ROLLBACK", bindings: [])
                throw error
            }
        }
    }

    private func saveThreadSnapshotUnlocked(threadID: String, snapshotJSON: Data, snapshotSequence: Int) throws {
        try execute(
            """
            INSERT OR REPLACE INTO thread_snapshots (
              thread_id, snapshot_json, snapshot_sequence, protocol_version,
              snapshot_schema_version, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            bindings: [
                threadID,
                String(data: snapshotJSON, encoding: .utf8) ?? "{}",
                String(snapshotSequence),
                mobileProtocolVersion,
                String(Self.shellSnapshotSchemaVersion),
                Self.nowString(),
            ]
        )
    }

    func loadThreadSnapshot(threadID: String) throws -> (json: Data, sequence: Int)? {
        try locked {
            let rows = try query(
                """
                SELECT snapshot_json, snapshot_sequence
                FROM thread_snapshots
                WHERE thread_id = ?
                LIMIT 1
                """,
                bindings: [threadID]
            )
            guard let row = rows.first else {
                return nil
            }
            return (
                Data(try text(row, "snapshot_json").utf8),
                Int(try text(row, "snapshot_sequence")) ?? 0
            )
        }
    }

    func loadEventCursor(name: String) throws -> Int? {
        try locked {
            let rows = try query(
                """
                SELECT sequence
                FROM event_cursors
                WHERE name = ?
                LIMIT 1
                """,
                bindings: [name]
            )
            guard let row = rows.first else {
                return nil
            }
            return Int(try text(row, "sequence"))
        }
    }

    func saveEventCursor(name: String, sequence: Int) throws {
        try locked {
        try execute(
            """
            INSERT OR REPLACE INTO event_cursors (name, sequence, updated_at)
            VALUES (?, ?, ?)
            """,
            bindings: [name, String(sequence), Self.nowString()]
        )
        }
    }

    func saveSubscriptionCursor(scope: String, aggregateID: String, sequence: Int) throws {
        try locked {
        try execute(
            """
            INSERT OR REPLACE INTO subscription_cursors (scope, aggregate_id, sequence, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            bindings: [scope, aggregateID, String(sequence), Self.nowString()]
        )
        }
    }

    func saveReplayGap(scope: String, envelope: MobileReplayEnvelope) throws {
        try locked {
        try execute(
            """
            INSERT OR REPLACE INTO replay_gaps (
              scope, from_sequence, server_high_water_sequence, message, detected_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            bindings: [
                scope,
                String(envelope.fromSequenceExclusive),
                String(envelope.serverHighWaterSequence),
                envelope.error?.message ?? envelope.status,
                Self.nowString(),
            ]
        )
        }
    }

    func savePendingCommand(
        commandID: String,
        commandType: String,
        payloadJSON: Data,
        status: MobilePendingCommandStatus
    ) throws {
        try locked {
        try execute(
            """
            INSERT OR REPLACE INTO pending_commands (
              command_id, command_type, payload_json, status, created_at, updated_at,
              accepted_sequence, error_message
            )
            VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM pending_commands WHERE command_id = ?), ?), ?, NULL, NULL)
            """,
            bindings: [
                commandID,
                commandType,
                String(data: payloadJSON, encoding: .utf8) ?? "{}",
                status.rawValue,
                commandID,
                Self.nowString(),
                Self.nowString(),
            ]
        )
        }
    }

    func updatePendingCommand(commandID: String, receipt: MobileCommandReceipt) throws {
        try locked {
        try execute(
            """
            UPDATE pending_commands
            SET status = ?, accepted_sequence = ?, error_message = ?, updated_at = ?
            WHERE command_id = ?
            """,
            bindings: [
                receipt.status == "accepted" || receipt.status == "duplicate"
                    ? MobilePendingCommandStatus.accepted.rawValue
                    : MobilePendingCommandStatus.rejected.rawValue,
                receipt.sequence.map(String.init) ?? "",
                receipt.error?.message ?? "",
                Self.nowString(),
                commandID,
            ]
        )
        }
    }

    func saveAttachmentMetadata(id: String, metadataJSON: Data, localPath: String?) throws {
        try locked {
        try execute(
            """
            INSERT OR REPLACE INTO attachments (id, metadata_json, local_path, created_at)
            VALUES (?, ?, ?, COALESCE((SELECT created_at FROM attachments WHERE id = ?), ?))
            """,
            bindings: [
                id,
                String(data: metadataJSON, encoding: .utf8) ?? "{}",
                localPath ?? "",
                id,
                Self.nowString(),
            ]
        )
        }
    }

    private func locked<T>(_ operation: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }

    private func saveShellUnlocked(environment: MobileEnvironment, shellState: MobileShellState) throws {
        let savedAt = Self.nowString()
        try execute(
            """
            INSERT OR REPLACE INTO shell_cache (
              id, environment_json, shell_json, snapshot_sequence, protocol_version,
              snapshot_schema_version, saved_at
            )
            VALUES (1, ?, ?, ?, ?, ?, ?)
            """,
            bindings: [
                String(data: try encoder.encode(environment), encoding: .utf8) ?? "{}",
                String(data: try encoder.encode(shellState), encoding: .utf8) ?? "{}",
                String(shellState.snapshotSequence),
                mobileProtocolVersion,
                String(Self.shellSnapshotSchemaVersion),
                savedAt,
            ]
        )
        try saveMetadataUnlocked(key: "protocol_version", value: mobileProtocolVersion)
        try saveMetadataUnlocked(
            key: "shell_snapshot_schema_version",
            value: String(Self.shellSnapshotSchemaVersion)
        )
        try saveEventCursorUnlocked(name: "shell", sequence: shellState.snapshotSequence)
    }

    private func migrate() throws {
        try execute("PRAGMA journal_mode = WAL", bindings: [])
        try execute("PRAGMA foreign_keys = ON", bindings: [])
        let currentVersion = try userVersion()
        guard currentVersion <= Self.schemaVersion else {
            throw MobileCacheError.unsupportedSchemaVersion(Int(currentVersion))
        }
        if currentVersion < 1 {
            try migrateToVersion1()
            try setUserVersion(Self.schemaVersion)
        }
    }

    private func migrateToVersion1() throws {
        try execute(
            """
            CREATE TABLE IF NOT EXISTS metadata (
              key TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS shell_cache (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              environment_json TEXT NOT NULL,
              shell_json TEXT NOT NULL,
              snapshot_sequence INTEGER NOT NULL,
              protocol_version TEXT NOT NULL,
              snapshot_schema_version INTEGER NOT NULL,
              saved_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS thread_snapshots (
              thread_id TEXT PRIMARY KEY NOT NULL,
              snapshot_json TEXT NOT NULL,
              snapshot_sequence INTEGER NOT NULL,
              protocol_version TEXT NOT NULL,
              snapshot_schema_version INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS event_cursors (
              name TEXT PRIMARY KEY NOT NULL,
              sequence INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS subscription_cursors (
              scope TEXT NOT NULL,
              aggregate_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (scope, aggregate_id)
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS replay_gaps (
              scope TEXT PRIMARY KEY NOT NULL,
              from_sequence INTEGER NOT NULL,
              server_high_water_sequence INTEGER NOT NULL,
              message TEXT NOT NULL,
              detected_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS pending_commands (
              command_id TEXT PRIMARY KEY NOT NULL,
              command_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              accepted_sequence INTEGER,
              error_message TEXT
            )
            """,
            bindings: []
        )
        try execute(
            """
            CREATE TABLE IF NOT EXISTS attachments (
              id TEXT PRIMARY KEY NOT NULL,
              metadata_json TEXT NOT NULL,
              local_path TEXT,
              created_at TEXT NOT NULL
            )
            """,
            bindings: []
        )
    }

    private func userVersion() throws -> Int32 {
        let rows = try query("PRAGMA user_version", bindings: [])
        guard let value = rows.first?.values.first, let version = Int32(value) else {
            return 0
        }
        return version
    }

    private func setUserVersion(_ version: Int32) throws {
        try execute("PRAGMA user_version = \(version)", bindings: [])
    }

    private func saveMetadata(key: String, value: String) throws {
        try locked {
            try saveMetadataUnlocked(key: key, value: value)
        }
    }

    private func saveMetadataUnlocked(key: String, value: String) throws {
        try execute(
            """
            INSERT OR REPLACE INTO metadata (key, value, updated_at)
            VALUES (?, ?, ?)
            """,
            bindings: [key, value, Self.nowString()]
        )
    }

    private func saveEventCursorUnlocked(name: String, sequence: Int) throws {
        try execute(
            """
            INSERT OR REPLACE INTO event_cursors (name, sequence, updated_at)
            VALUES (?, ?, ?)
            """,
            bindings: [name, String(sequence), Self.nowString()]
        )
    }

    private func execute(_ sql: String, bindings: [String]) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        var stepResult = sqlite3_step(statement)
        while stepResult == SQLITE_ROW {
            stepResult = sqlite3_step(statement)
        }
        if stepResult != SQLITE_DONE {
            throw MobileCacheError.stepFailed(Self.errorMessage(database))
        }
    }

    private func query(_ sql: String, bindings: [String]) throws -> [[String: String]] {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)

        var rows: [[String: String]] = []
        var stepResult = sqlite3_step(statement)
        while stepResult == SQLITE_ROW {
            var row: [String: String] = [:]
            for index in 0..<sqlite3_column_count(statement) {
                guard let columnName = sqlite3_column_name(statement, index) else {
                    continue
                }
                let name = String(cString: columnName)
                if let text = sqlite3_column_text(statement, index) {
                    row[name] = String(cString: text)
                } else {
                    row[name] = ""
                }
            }
            rows.append(row)
            stepResult = sqlite3_step(statement)
        }
        if stepResult != SQLITE_DONE {
            throw MobileCacheError.stepFailed(Self.errorMessage(database))
        }
        return rows
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(database, sql, -1, &statement, nil) != SQLITE_OK {
            throw MobileCacheError.prepareFailed(Self.errorMessage(database))
        }
        return statement
    }

    private func bind(_ bindings: [String], to statement: OpaquePointer?) throws {
        for (index, value) in bindings.enumerated() {
            if sqlite3_bind_text(statement, Int32(index + 1), value, -1, Self.sqliteTransient) != SQLITE_OK {
                throw MobileCacheError.bindFailed(Self.errorMessage(database))
            }
        }
    }

    private func text(_ row: [String: String], _ column: String) throws -> String {
        guard let value = row[column] else {
            throw MobileCacheError.invalidTextColumn(column)
        }
        return value
    }

    private static func errorMessage(_ database: OpaquePointer?) -> String {
        guard let database, let message = sqlite3_errmsg(database) else {
            return "unknown SQLite error"
        }
        return String(cString: message)
    }

    private static func nowString() -> String {
        Date().ISO8601Format()
    }

    private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}
