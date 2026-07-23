import * as Data from "effect/Data";

/**
 * Base error properties shared by all SQLite errors.
 */
interface SQLiteErrorProps {
  readonly message: string;
  readonly cause?: unknown;
}

// =============================================================================
// Primary Result Codes
// =============================================================================

/**
 * SQLITE_ERROR (1) - Generic error code.
 */
export class SQLiteError extends Data.TaggedError(
  "SQLITE_ERROR",
)<SQLiteErrorProps> {}

/**
 * SQLITE_INTERNAL (2) - Internal malfunction.
 */
export class SQLiteInternal extends Data.TaggedError(
  "SQLITE_INTERNAL",
)<SQLiteErrorProps> {}

/**
 * SQLITE_PERM (3) - Access permission denied.
 */
export class SQLitePerm extends Data.TaggedError(
  "SQLITE_PERM",
)<SQLiteErrorProps> {}

/**
 * SQLITE_ABORT (4) - Operation aborted.
 */
export class SQLiteAbort extends Data.TaggedError(
  "SQLITE_ABORT",
)<SQLiteErrorProps> {}

/**
 * SQLITE_BUSY (5) - Database file is locked.
 */
export class SQLiteBusy extends Data.TaggedError(
  "SQLITE_BUSY",
)<SQLiteErrorProps> {}

/**
 * SQLITE_LOCKED (6) - A table in the database is locked.
 */
export class SQLiteLocked extends Data.TaggedError(
  "SQLITE_LOCKED",
)<SQLiteErrorProps> {}

/**
 * SQLITE_NOMEM (7) - Memory allocation failed.
 */
export class SQLiteNomem extends Data.TaggedError(
  "SQLITE_NOMEM",
)<SQLiteErrorProps> {}

/**
 * SQLITE_READONLY (8) - Attempt to write a readonly database.
 */
export class SQLiteReadonly extends Data.TaggedError(
  "SQLITE_READONLY",
)<SQLiteErrorProps> {}

/**
 * SQLITE_INTERRUPT (9) - Operation interrupted.
 */
export class SQLiteInterrupt extends Data.TaggedError(
  "SQLITE_INTERRUPT",
)<SQLiteErrorProps> {}

/**
 * SQLITE_IOERR (10) - I/O error.
 */
export class SQLiteIoerr extends Data.TaggedError(
  "SQLITE_IOERR",
)<SQLiteErrorProps> {}

/**
 * SQLITE_CORRUPT (11) - Database disk image is malformed.
 */
export class SQLiteCorrupt extends Data.TaggedError(
  "SQLITE_CORRUPT",
)<SQLiteErrorProps> {}

/**
 * SQLITE_NOTFOUND (12) - Unknown opcode or table not found.
 */
export class SQLiteNotfound extends Data.TaggedError(
  "SQLITE_NOTFOUND",
)<SQLiteErrorProps> {}

/**
 * SQLITE_FULL (13) - Database or disk is full.
 */
export class SQLiteFull extends Data.TaggedError(
  "SQLITE_FULL",
)<SQLiteErrorProps> {}

/**
 * SQLITE_CANTOPEN (14) - Unable to open database file.
 */
export class SQLiteCantopen extends Data.TaggedError(
  "SQLITE_CANTOPEN",
)<SQLiteErrorProps> {}

/**
 * SQLITE_PROTOCOL (15) - Database lock protocol error.
 */
export class SQLiteProtocol extends Data.TaggedError(
  "SQLITE_PROTOCOL",
)<SQLiteErrorProps> {}

/**
 * SQLITE_EMPTY (16) - Internal use only.
 */
export class SQLiteEmpty extends Data.TaggedError(
  "SQLITE_EMPTY",
)<SQLiteErrorProps> {}

/**
 * SQLITE_SCHEMA (17) - Database schema changed.
 */
export class SQLiteSchema extends Data.TaggedError(
  "SQLITE_SCHEMA",
)<SQLiteErrorProps> {}

/**
 * SQLITE_TOOBIG (18) - String or BLOB exceeds size limit.
 */
export class SQLiteToobig extends Data.TaggedError(
  "SQLITE_TOOBIG",
)<SQLiteErrorProps> {}

/**
 * SQLITE_CONSTRAINT (19) - Constraint violation.
 */
export class SQLiteConstraint extends Data.TaggedError(
  "SQLITE_CONSTRAINT",
)<SQLiteErrorProps> {}

/**
 * SQLITE_MISMATCH (20) - Data type mismatch.
 */
export class SQLiteMismatch extends Data.TaggedError(
  "SQLITE_MISMATCH",
)<SQLiteErrorProps> {}

/**
 * SQLITE_MISUSE (21) - Library used incorrectly.
 */
export class SQLiteMisuse extends Data.TaggedError(
  "SQLITE_MISUSE",
)<SQLiteErrorProps> {}

/**
 * SQLITE_NOLFS (22) - Uses OS features not supported on host.
 */
export class SQLiteNolfs extends Data.TaggedError(
  "SQLITE_NOLFS",
)<SQLiteErrorProps> {}

/**
 * SQLITE_AUTH (23) - Authorization denied.
 */
export class SQLiteAuth extends Data.TaggedError(
  "SQLITE_AUTH",
)<SQLiteErrorProps> {}

/**
 * SQLITE_FORMAT (24) - Not used.
 */
export class SQLiteFormat extends Data.TaggedError(
  "SQLITE_FORMAT",
)<SQLiteErrorProps> {}

/**
 * SQLITE_RANGE (25) - 2nd parameter to sqlite3_bind out of range.
 */
export class SQLiteRange extends Data.TaggedError(
  "SQLITE_RANGE",
)<SQLiteErrorProps> {}

/**
 * SQLITE_NOTADB (26) - File opened that is not a database file.
 */
export class SQLiteNotadb extends Data.TaggedError(
  "SQLITE_NOTADB",
)<SQLiteErrorProps> {}

/**
 * SQLITE_NOTICE (27) - Notifications from sqlite3_log().
 */
export class SQLiteNotice extends Data.TaggedError(
  "SQLITE_NOTICE",
)<SQLiteErrorProps> {}

/**
 * SQLITE_WARNING (28) - Warnings from sqlite3_log().
 */
export class SQLiteWarning extends Data.TaggedError(
  "SQLITE_WARNING",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - ABORT
// =============================================================================

export class SQLiteAbortRollback extends Data.TaggedError(
  "SQLITE_ABORT_ROLLBACK",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - AUTH
// =============================================================================

export class SQLiteAuthUser extends Data.TaggedError(
  "SQLITE_AUTH_USER",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - BUSY
// =============================================================================

export class SQLiteBusyRecovery extends Data.TaggedError(
  "SQLITE_BUSY_RECOVERY",
)<SQLiteErrorProps> {}
export class SQLiteBusySnapshot extends Data.TaggedError(
  "SQLITE_BUSY_SNAPSHOT",
)<SQLiteErrorProps> {}
export class SQLiteBusyTimeout extends Data.TaggedError(
  "SQLITE_BUSY_TIMEOUT",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - CANTOPEN
// =============================================================================

export class SQLiteCantopenConvpath extends Data.TaggedError(
  "SQLITE_CANTOPEN_CONVPATH",
)<SQLiteErrorProps> {}
export class SQLiteCantopenDirtywal extends Data.TaggedError(
  "SQLITE_CANTOPEN_DIRTYWAL",
)<SQLiteErrorProps> {}
export class SQLiteCantopenFullpath extends Data.TaggedError(
  "SQLITE_CANTOPEN_FULLPATH",
)<SQLiteErrorProps> {}
export class SQLiteCantopenIsdir extends Data.TaggedError(
  "SQLITE_CANTOPEN_ISDIR",
)<SQLiteErrorProps> {}
export class SQLiteCantopenNotempdir extends Data.TaggedError(
  "SQLITE_CANTOPEN_NOTEMPDIR",
)<SQLiteErrorProps> {}
export class SQLiteCantopenSymlink extends Data.TaggedError(
  "SQLITE_CANTOPEN_SYMLINK",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - CONSTRAINT
// =============================================================================

export class SQLiteConstraintCheck extends Data.TaggedError(
  "SQLITE_CONSTRAINT_CHECK",
)<SQLiteErrorProps> {}
export class SQLiteConstraintCommithook extends Data.TaggedError(
  "SQLITE_CONSTRAINT_COMMITHOOK",
)<SQLiteErrorProps> {}
export class SQLiteConstraintDatatype extends Data.TaggedError(
  "SQLITE_CONSTRAINT_DATATYPE",
)<SQLiteErrorProps> {}
export class SQLiteConstraintForeignkey extends Data.TaggedError(
  "SQLITE_CONSTRAINT_FOREIGNKEY",
)<SQLiteErrorProps> {}
export class SQLiteConstraintFunction extends Data.TaggedError(
  "SQLITE_CONSTRAINT_FUNCTION",
)<SQLiteErrorProps> {}
export class SQLiteConstraintNotnull extends Data.TaggedError(
  "SQLITE_CONSTRAINT_NOTNULL",
)<SQLiteErrorProps> {}
export class SQLiteConstraintPinned extends Data.TaggedError(
  "SQLITE_CONSTRAINT_PINNED",
)<SQLiteErrorProps> {}
export class SQLiteConstraintPrimarykey extends Data.TaggedError(
  "SQLITE_CONSTRAINT_PRIMARYKEY",
)<SQLiteErrorProps> {}
export class SQLiteConstraintRowid extends Data.TaggedError(
  "SQLITE_CONSTRAINT_ROWID",
)<SQLiteErrorProps> {}
export class SQLiteConstraintTrigger extends Data.TaggedError(
  "SQLITE_CONSTRAINT_TRIGGER",
)<SQLiteErrorProps> {}
export class SQLiteConstraintUnique extends Data.TaggedError(
  "SQLITE_CONSTRAINT_UNIQUE",
)<SQLiteErrorProps> {}
export class SQLiteConstraintVtab extends Data.TaggedError(
  "SQLITE_CONSTRAINT_VTAB",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - CORRUPT
// =============================================================================

export class SQLiteCorruptIndex extends Data.TaggedError(
  "SQLITE_CORRUPT_INDEX",
)<SQLiteErrorProps> {}
export class SQLiteCorruptSequence extends Data.TaggedError(
  "SQLITE_CORRUPT_SEQUENCE",
)<SQLiteErrorProps> {}
export class SQLiteCorruptVtab extends Data.TaggedError(
  "SQLITE_CORRUPT_VTAB",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - ERROR
// =============================================================================

export class SQLiteErrorMissingCollseq extends Data.TaggedError(
  "SQLITE_ERROR_MISSING_COLLSEQ",
)<SQLiteErrorProps> {}
export class SQLiteErrorRetry extends Data.TaggedError(
  "SQLITE_ERROR_RETRY",
)<SQLiteErrorProps> {}
export class SQLiteErrorSnapshot extends Data.TaggedError(
  "SQLITE_ERROR_SNAPSHOT",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - IOERR
// =============================================================================

export class SQLiteIoerrAccess extends Data.TaggedError(
  "SQLITE_IOERR_ACCESS",
)<SQLiteErrorProps> {}
export class SQLiteIoerrAuth extends Data.TaggedError(
  "SQLITE_IOERR_AUTH",
)<SQLiteErrorProps> {}
export class SQLiteIoerrBeginAtomic extends Data.TaggedError(
  "SQLITE_IOERR_BEGIN_ATOMIC",
)<SQLiteErrorProps> {}
export class SQLiteIoerrBlocked extends Data.TaggedError(
  "SQLITE_IOERR_BLOCKED",
)<SQLiteErrorProps> {}
export class SQLiteIoerrCheckreservedlock extends Data.TaggedError(
  "SQLITE_IOERR_CHECKRESERVEDLOCK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrClose extends Data.TaggedError(
  "SQLITE_IOERR_CLOSE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrCommitAtomic extends Data.TaggedError(
  "SQLITE_IOERR_COMMIT_ATOMIC",
)<SQLiteErrorProps> {}
export class SQLiteIoerrConvpath extends Data.TaggedError(
  "SQLITE_IOERR_CONVPATH",
)<SQLiteErrorProps> {}
export class SQLiteIoerrCorruptfs extends Data.TaggedError(
  "SQLITE_IOERR_CORRUPTFS",
)<SQLiteErrorProps> {}
export class SQLiteIoerrData extends Data.TaggedError(
  "SQLITE_IOERR_DATA",
)<SQLiteErrorProps> {}
export class SQLiteIoerrDelete extends Data.TaggedError(
  "SQLITE_IOERR_DELETE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrDeleteNoent extends Data.TaggedError(
  "SQLITE_IOERR_DELETE_NOENT",
)<SQLiteErrorProps> {}
export class SQLiteIoerrDirClose extends Data.TaggedError(
  "SQLITE_IOERR_DIR_CLOSE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrDirFsync extends Data.TaggedError(
  "SQLITE_IOERR_DIR_FSYNC",
)<SQLiteErrorProps> {}
export class SQLiteIoerrFstat extends Data.TaggedError(
  "SQLITE_IOERR_FSTAT",
)<SQLiteErrorProps> {}
export class SQLiteIoerrFsync extends Data.TaggedError(
  "SQLITE_IOERR_FSYNC",
)<SQLiteErrorProps> {}
export class SQLiteIoerrGettemppath extends Data.TaggedError(
  "SQLITE_IOERR_GETTEMPPATH",
)<SQLiteErrorProps> {}
export class SQLiteIoerrLock extends Data.TaggedError(
  "SQLITE_IOERR_LOCK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrMmap extends Data.TaggedError(
  "SQLITE_IOERR_MMAP",
)<SQLiteErrorProps> {}
export class SQLiteIoerrNomem extends Data.TaggedError(
  "SQLITE_IOERR_NOMEM",
)<SQLiteErrorProps> {}
export class SQLiteIoerrRdlock extends Data.TaggedError(
  "SQLITE_IOERR_RDLOCK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrRead extends Data.TaggedError(
  "SQLITE_IOERR_READ",
)<SQLiteErrorProps> {}
export class SQLiteIoerrRollbackAtomic extends Data.TaggedError(
  "SQLITE_IOERR_ROLLBACK_ATOMIC",
)<SQLiteErrorProps> {}
export class SQLiteIoerrSeek extends Data.TaggedError(
  "SQLITE_IOERR_SEEK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrShmlock extends Data.TaggedError(
  "SQLITE_IOERR_SHMLOCK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrShmmap extends Data.TaggedError(
  "SQLITE_IOERR_SHMMAP",
)<SQLiteErrorProps> {}
export class SQLiteIoerrShmopen extends Data.TaggedError(
  "SQLITE_IOERR_SHMOPEN",
)<SQLiteErrorProps> {}
export class SQLiteIoerrShmsize extends Data.TaggedError(
  "SQLITE_IOERR_SHMSIZE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrShortRead extends Data.TaggedError(
  "SQLITE_IOERR_SHORT_READ",
)<SQLiteErrorProps> {}
export class SQLiteIoerrTruncate extends Data.TaggedError(
  "SQLITE_IOERR_TRUNCATE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrUnlock extends Data.TaggedError(
  "SQLITE_IOERR_UNLOCK",
)<SQLiteErrorProps> {}
export class SQLiteIoerrVnode extends Data.TaggedError(
  "SQLITE_IOERR_VNODE",
)<SQLiteErrorProps> {}
export class SQLiteIoerrWrite extends Data.TaggedError(
  "SQLITE_IOERR_WRITE",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - LOCKED
// =============================================================================

export class SQLiteLockedSharedcache extends Data.TaggedError(
  "SQLITE_LOCKED_SHAREDCACHE",
)<SQLiteErrorProps> {}
export class SQLiteLockedVtab extends Data.TaggedError(
  "SQLITE_LOCKED_VTAB",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - NOTICE
// =============================================================================

export class SQLiteNoticeRecoverRollback extends Data.TaggedError(
  "SQLITE_NOTICE_RECOVER_ROLLBACK",
)<SQLiteErrorProps> {}
export class SQLiteNoticeRecoverWal extends Data.TaggedError(
  "SQLITE_NOTICE_RECOVER_WAL",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - READONLY
// =============================================================================

export class SQLiteReadonlyCantinit extends Data.TaggedError(
  "SQLITE_READONLY_CANTINIT",
)<SQLiteErrorProps> {}
export class SQLiteReadonlyCantlock extends Data.TaggedError(
  "SQLITE_READONLY_CANTLOCK",
)<SQLiteErrorProps> {}
export class SQLiteReadonlyDbmoved extends Data.TaggedError(
  "SQLITE_READONLY_DBMOVED",
)<SQLiteErrorProps> {}
export class SQLiteReadonlyDirectory extends Data.TaggedError(
  "SQLITE_READONLY_DIRECTORY",
)<SQLiteErrorProps> {}
export class SQLiteReadonlyRecovery extends Data.TaggedError(
  "SQLITE_READONLY_RECOVERY",
)<SQLiteErrorProps> {}
export class SQLiteReadonlyRollback extends Data.TaggedError(
  "SQLITE_READONLY_ROLLBACK",
)<SQLiteErrorProps> {}

// =============================================================================
// Extended Result Codes - WARNING
// =============================================================================

export class SQLiteWarningAutoindex extends Data.TaggedError(
  "SQLITE_WARNING_AUTOINDEX",
)<SQLiteErrorProps> {}

// =============================================================================
// Unknown Error (fallback)
// =============================================================================

/**
 * Fallback for unknown or unrecognized SQLite error codes.
 */
export class SQLiteUnknownError extends Data.TaggedError("SQLITE_UNKNOWN")<
  SQLiteErrorProps & {
    readonly code?: string;
  }
> {}

// =============================================================================
// Union Type
// =============================================================================

/**
 * Union of all SQLite error types.
 */
export type SQLiteErrorType =
  // Primary result codes
  | SQLiteError
  | SQLiteInternal
  | SQLitePerm
  | SQLiteAbort
  | SQLiteBusy
  | SQLiteLocked
  | SQLiteNomem
  | SQLiteReadonly
  | SQLiteInterrupt
  | SQLiteIoerr
  | SQLiteCorrupt
  | SQLiteNotfound
  | SQLiteFull
  | SQLiteCantopen
  | SQLiteProtocol
  | SQLiteEmpty
  | SQLiteSchema
  | SQLiteToobig
  | SQLiteConstraint
  | SQLiteMismatch
  | SQLiteMisuse
  | SQLiteNolfs
  | SQLiteAuth
  | SQLiteFormat
  | SQLiteRange
  | SQLiteNotadb
  | SQLiteNotice
  | SQLiteWarning
  // Extended - ABORT
  | SQLiteAbortRollback
  // Extended - AUTH
  | SQLiteAuthUser
  // Extended - BUSY
  | SQLiteBusyRecovery
  | SQLiteBusySnapshot
  | SQLiteBusyTimeout
  // Extended - CANTOPEN
  | SQLiteCantopenConvpath
  | SQLiteCantopenDirtywal
  | SQLiteCantopenFullpath
  | SQLiteCantopenIsdir
  | SQLiteCantopenNotempdir
  | SQLiteCantopenSymlink
  // Extended - CONSTRAINT
  | SQLiteConstraintCheck
  | SQLiteConstraintCommithook
  | SQLiteConstraintDatatype
  | SQLiteConstraintForeignkey
  | SQLiteConstraintFunction
  | SQLiteConstraintNotnull
  | SQLiteConstraintPinned
  | SQLiteConstraintPrimarykey
  | SQLiteConstraintRowid
  | SQLiteConstraintTrigger
  | SQLiteConstraintUnique
  | SQLiteConstraintVtab
  // Extended - CORRUPT
  | SQLiteCorruptIndex
  | SQLiteCorruptSequence
  | SQLiteCorruptVtab
  // Extended - ERROR
  | SQLiteErrorMissingCollseq
  | SQLiteErrorRetry
  | SQLiteErrorSnapshot
  // Extended - IOERR
  | SQLiteIoerrAccess
  | SQLiteIoerrAuth
  | SQLiteIoerrBeginAtomic
  | SQLiteIoerrBlocked
  | SQLiteIoerrCheckreservedlock
  | SQLiteIoerrClose
  | SQLiteIoerrCommitAtomic
  | SQLiteIoerrConvpath
  | SQLiteIoerrCorruptfs
  | SQLiteIoerrData
  | SQLiteIoerrDelete
  | SQLiteIoerrDeleteNoent
  | SQLiteIoerrDirClose
  | SQLiteIoerrDirFsync
  | SQLiteIoerrFstat
  | SQLiteIoerrFsync
  | SQLiteIoerrGettemppath
  | SQLiteIoerrLock
  | SQLiteIoerrMmap
  | SQLiteIoerrNomem
  | SQLiteIoerrRdlock
  | SQLiteIoerrRead
  | SQLiteIoerrRollbackAtomic
  | SQLiteIoerrSeek
  | SQLiteIoerrShmlock
  | SQLiteIoerrShmmap
  | SQLiteIoerrShmopen
  | SQLiteIoerrShmsize
  | SQLiteIoerrShortRead
  | SQLiteIoerrTruncate
  | SQLiteIoerrUnlock
  | SQLiteIoerrVnode
  | SQLiteIoerrWrite
  // Extended - LOCKED
  | SQLiteLockedSharedcache
  | SQLiteLockedVtab
  // Extended - NOTICE
  | SQLiteNoticeRecoverRollback
  | SQLiteNoticeRecoverWal
  // Extended - READONLY
  | SQLiteReadonlyCantinit
  | SQLiteReadonlyCantlock
  | SQLiteReadonlyDbmoved
  | SQLiteReadonlyDirectory
  | SQLiteReadonlyRecovery
  | SQLiteReadonlyRollback
  // Extended - WARNING
  | SQLiteWarningAutoindex
  // Unknown
  | SQLiteUnknownError;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Type guard to check if an error is a SQLite error with a _tag.
 */
export const isSQLiteError = (error: unknown): error is SQLiteErrorType => {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("SQLITE_")
  );
};

/**
 * Check if the error is retryable (busy or locked errors).
 */
export const isRetryable = (e: SQLiteErrorType): boolean => {
  switch (e._tag) {
    case "SQLITE_BUSY":
    case "SQLITE_BUSY_RECOVERY":
    case "SQLITE_BUSY_SNAPSHOT":
    case "SQLITE_BUSY_TIMEOUT":
    case "SQLITE_LOCKED":
    case "SQLITE_LOCKED_SHAREDCACHE":
    case "SQLITE_LOCKED_VTAB":
      return true;
    default:
      return false;
  }
};

/**
 * Parse an error from a SQLite client into a typed error.
 */
export const parseError = (
  code: string | undefined,
  message: string,
  cause?: unknown,
): SQLiteErrorType => {
  switch (code) {
    // Primary result codes
    case "SQLITE_ERROR":
      return new SQLiteError({ message, cause });
    case "SQLITE_INTERNAL":
      return new SQLiteInternal({ message, cause });
    case "SQLITE_PERM":
      return new SQLitePerm({ message, cause });
    case "SQLITE_ABORT":
      return new SQLiteAbort({ message, cause });
    case "SQLITE_BUSY":
      return new SQLiteBusy({ message, cause });
    case "SQLITE_LOCKED":
      return new SQLiteLocked({ message, cause });
    case "SQLITE_NOMEM":
      return new SQLiteNomem({ message, cause });
    case "SQLITE_READONLY":
      return new SQLiteReadonly({ message, cause });
    case "SQLITE_INTERRUPT":
      return new SQLiteInterrupt({ message, cause });
    case "SQLITE_IOERR":
      return new SQLiteIoerr({ message, cause });
    case "SQLITE_CORRUPT":
      return new SQLiteCorrupt({ message, cause });
    case "SQLITE_NOTFOUND":
      return new SQLiteNotfound({ message, cause });
    case "SQLITE_FULL":
      return new SQLiteFull({ message, cause });
    case "SQLITE_CANTOPEN":
      return new SQLiteCantopen({ message, cause });
    case "SQLITE_PROTOCOL":
      return new SQLiteProtocol({ message, cause });
    case "SQLITE_EMPTY":
      return new SQLiteEmpty({ message, cause });
    case "SQLITE_SCHEMA":
      return new SQLiteSchema({ message, cause });
    case "SQLITE_TOOBIG":
      return new SQLiteToobig({ message, cause });
    case "SQLITE_CONSTRAINT":
      return new SQLiteConstraint({ message, cause });
    case "SQLITE_MISMATCH":
      return new SQLiteMismatch({ message, cause });
    case "SQLITE_MISUSE":
      return new SQLiteMisuse({ message, cause });
    case "SQLITE_NOLFS":
      return new SQLiteNolfs({ message, cause });
    case "SQLITE_AUTH":
      return new SQLiteAuth({ message, cause });
    case "SQLITE_FORMAT":
      return new SQLiteFormat({ message, cause });
    case "SQLITE_RANGE":
      return new SQLiteRange({ message, cause });
    case "SQLITE_NOTADB":
      return new SQLiteNotadb({ message, cause });
    case "SQLITE_NOTICE":
      return new SQLiteNotice({ message, cause });
    case "SQLITE_WARNING":
      return new SQLiteWarning({ message, cause });

    // Extended - ABORT
    case "SQLITE_ABORT_ROLLBACK":
      return new SQLiteAbortRollback({ message, cause });

    // Extended - AUTH
    case "SQLITE_AUTH_USER":
      return new SQLiteAuthUser({ message, cause });

    // Extended - BUSY
    case "SQLITE_BUSY_RECOVERY":
      return new SQLiteBusyRecovery({ message, cause });
    case "SQLITE_BUSY_SNAPSHOT":
      return new SQLiteBusySnapshot({ message, cause });
    case "SQLITE_BUSY_TIMEOUT":
      return new SQLiteBusyTimeout({ message, cause });

    // Extended - CANTOPEN
    case "SQLITE_CANTOPEN_CONVPATH":
      return new SQLiteCantopenConvpath({ message, cause });
    case "SQLITE_CANTOPEN_DIRTYWAL":
      return new SQLiteCantopenDirtywal({ message, cause });
    case "SQLITE_CANTOPEN_FULLPATH":
      return new SQLiteCantopenFullpath({ message, cause });
    case "SQLITE_CANTOPEN_ISDIR":
      return new SQLiteCantopenIsdir({ message, cause });
    case "SQLITE_CANTOPEN_NOTEMPDIR":
      return new SQLiteCantopenNotempdir({ message, cause });
    case "SQLITE_CANTOPEN_SYMLINK":
      return new SQLiteCantopenSymlink({ message, cause });

    // Extended - CONSTRAINT
    case "SQLITE_CONSTRAINT_CHECK":
      return new SQLiteConstraintCheck({ message, cause });
    case "SQLITE_CONSTRAINT_COMMITHOOK":
      return new SQLiteConstraintCommithook({ message, cause });
    case "SQLITE_CONSTRAINT_DATATYPE":
      return new SQLiteConstraintDatatype({ message, cause });
    case "SQLITE_CONSTRAINT_FOREIGNKEY":
      return new SQLiteConstraintForeignkey({ message, cause });
    case "SQLITE_CONSTRAINT_FUNCTION":
      return new SQLiteConstraintFunction({ message, cause });
    case "SQLITE_CONSTRAINT_NOTNULL":
      return new SQLiteConstraintNotnull({ message, cause });
    case "SQLITE_CONSTRAINT_PINNED":
      return new SQLiteConstraintPinned({ message, cause });
    case "SQLITE_CONSTRAINT_PRIMARYKEY":
      return new SQLiteConstraintPrimarykey({ message, cause });
    case "SQLITE_CONSTRAINT_ROWID":
      return new SQLiteConstraintRowid({ message, cause });
    case "SQLITE_CONSTRAINT_TRIGGER":
      return new SQLiteConstraintTrigger({ message, cause });
    case "SQLITE_CONSTRAINT_UNIQUE":
      return new SQLiteConstraintUnique({ message, cause });
    case "SQLITE_CONSTRAINT_VTAB":
      return new SQLiteConstraintVtab({ message, cause });

    // Extended - CORRUPT
    case "SQLITE_CORRUPT_INDEX":
      return new SQLiteCorruptIndex({ message, cause });
    case "SQLITE_CORRUPT_SEQUENCE":
      return new SQLiteCorruptSequence({ message, cause });
    case "SQLITE_CORRUPT_VTAB":
      return new SQLiteCorruptVtab({ message, cause });

    // Extended - ERROR
    case "SQLITE_ERROR_MISSING_COLLSEQ":
      return new SQLiteErrorMissingCollseq({ message, cause });
    case "SQLITE_ERROR_RETRY":
      return new SQLiteErrorRetry({ message, cause });
    case "SQLITE_ERROR_SNAPSHOT":
      return new SQLiteErrorSnapshot({ message, cause });

    // Extended - IOERR
    case "SQLITE_IOERR_ACCESS":
      return new SQLiteIoerrAccess({ message, cause });
    case "SQLITE_IOERR_AUTH":
      return new SQLiteIoerrAuth({ message, cause });
    case "SQLITE_IOERR_BEGIN_ATOMIC":
      return new SQLiteIoerrBeginAtomic({ message, cause });
    case "SQLITE_IOERR_BLOCKED":
      return new SQLiteIoerrBlocked({ message, cause });
    case "SQLITE_IOERR_CHECKRESERVEDLOCK":
      return new SQLiteIoerrCheckreservedlock({ message, cause });
    case "SQLITE_IOERR_CLOSE":
      return new SQLiteIoerrClose({ message, cause });
    case "SQLITE_IOERR_COMMIT_ATOMIC":
      return new SQLiteIoerrCommitAtomic({ message, cause });
    case "SQLITE_IOERR_CONVPATH":
      return new SQLiteIoerrConvpath({ message, cause });
    case "SQLITE_IOERR_CORRUPTFS":
      return new SQLiteIoerrCorruptfs({ message, cause });
    case "SQLITE_IOERR_DATA":
      return new SQLiteIoerrData({ message, cause });
    case "SQLITE_IOERR_DELETE":
      return new SQLiteIoerrDelete({ message, cause });
    case "SQLITE_IOERR_DELETE_NOENT":
      return new SQLiteIoerrDeleteNoent({ message, cause });
    case "SQLITE_IOERR_DIR_CLOSE":
      return new SQLiteIoerrDirClose({ message, cause });
    case "SQLITE_IOERR_DIR_FSYNC":
      return new SQLiteIoerrDirFsync({ message, cause });
    case "SQLITE_IOERR_FSTAT":
      return new SQLiteIoerrFstat({ message, cause });
    case "SQLITE_IOERR_FSYNC":
      return new SQLiteIoerrFsync({ message, cause });
    case "SQLITE_IOERR_GETTEMPPATH":
      return new SQLiteIoerrGettemppath({ message, cause });
    case "SQLITE_IOERR_LOCK":
      return new SQLiteIoerrLock({ message, cause });
    case "SQLITE_IOERR_MMAP":
      return new SQLiteIoerrMmap({ message, cause });
    case "SQLITE_IOERR_NOMEM":
      return new SQLiteIoerrNomem({ message, cause });
    case "SQLITE_IOERR_RDLOCK":
      return new SQLiteIoerrRdlock({ message, cause });
    case "SQLITE_IOERR_READ":
      return new SQLiteIoerrRead({ message, cause });
    case "SQLITE_IOERR_ROLLBACK_ATOMIC":
      return new SQLiteIoerrRollbackAtomic({ message, cause });
    case "SQLITE_IOERR_SEEK":
      return new SQLiteIoerrSeek({ message, cause });
    case "SQLITE_IOERR_SHMLOCK":
      return new SQLiteIoerrShmlock({ message, cause });
    case "SQLITE_IOERR_SHMMAP":
      return new SQLiteIoerrShmmap({ message, cause });
    case "SQLITE_IOERR_SHMOPEN":
      return new SQLiteIoerrShmopen({ message, cause });
    case "SQLITE_IOERR_SHMSIZE":
      return new SQLiteIoerrShmsize({ message, cause });
    case "SQLITE_IOERR_SHORT_READ":
      return new SQLiteIoerrShortRead({ message, cause });
    case "SQLITE_IOERR_TRUNCATE":
      return new SQLiteIoerrTruncate({ message, cause });
    case "SQLITE_IOERR_UNLOCK":
      return new SQLiteIoerrUnlock({ message, cause });
    case "SQLITE_IOERR_VNODE":
      return new SQLiteIoerrVnode({ message, cause });
    case "SQLITE_IOERR_WRITE":
      return new SQLiteIoerrWrite({ message, cause });

    // Extended - LOCKED
    case "SQLITE_LOCKED_SHAREDCACHE":
      return new SQLiteLockedSharedcache({ message, cause });
    case "SQLITE_LOCKED_VTAB":
      return new SQLiteLockedVtab({ message, cause });

    // Extended - NOTICE
    case "SQLITE_NOTICE_RECOVER_ROLLBACK":
      return new SQLiteNoticeRecoverRollback({ message, cause });
    case "SQLITE_NOTICE_RECOVER_WAL":
      return new SQLiteNoticeRecoverWal({ message, cause });

    // Extended - READONLY
    case "SQLITE_READONLY_CANTINIT":
      return new SQLiteReadonlyCantinit({ message, cause });
    case "SQLITE_READONLY_CANTLOCK":
      return new SQLiteReadonlyCantlock({ message, cause });
    case "SQLITE_READONLY_DBMOVED":
      return new SQLiteReadonlyDbmoved({ message, cause });
    case "SQLITE_READONLY_DIRECTORY":
      return new SQLiteReadonlyDirectory({ message, cause });
    case "SQLITE_READONLY_RECOVERY":
      return new SQLiteReadonlyRecovery({ message, cause });
    case "SQLITE_READONLY_ROLLBACK":
      return new SQLiteReadonlyRollback({ message, cause });

    // Extended - WARNING
    case "SQLITE_WARNING_AUTOINDEX":
      return new SQLiteWarningAutoindex({ message, cause });

    // Unknown/default
    default:
      return new SQLiteUnknownError({ message, cause, code });
  }
};
