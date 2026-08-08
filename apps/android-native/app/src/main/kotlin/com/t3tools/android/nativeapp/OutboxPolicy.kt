package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.RpcTransportException
import java.io.IOException

/** Pure outbox drain policy — unit-testable without Android or sockets. */
internal object OutboxPolicy {
  fun nextAttemptAt(nowMs: Long, attempt: Int): Long =
    nowMs + ConnectionPolicy.retryDelay(attempt)

  fun isTransient(error: Throwable): Boolean = when (error) {
    is RpcTransportException, is IOException -> true
    else -> error.cause?.let(::isTransient) == true
  }

  fun isBlockedConnection(error: Throwable): Boolean {
    val detail = error.message.orEmpty()
    return "No saved credential" in detail ||
      "Sign in to T3 Connect" in detail ||
      "does not match" in detail ||
      "HTTP 401" in detail ||
      "HTTP 403" in detail
  }

  fun normalizeRestoredStatus(status: PendingTaskStatus) =
    if (status == PendingTaskStatus.Sending) PendingTaskStatus.Queued else status

  fun claimForSend(
    current: PendingTask?,
    environmentId: String,
    threadId: String,
    nowMs: Long,
  ): PendingTask? {
    if (current == null || current.status != PendingTaskStatus.Queued) return null
    if (current.environmentId != environmentId || current.threadId != threadId) return null
    if (current.nextAttemptAt > nowMs) return null
    return current.copy(status = PendingTaskStatus.Sending, error = null)
  }

  fun canDrain(
    connectionPhase: ConnectionPhase,
    shellSyncPhase: SyncPhase,
    nowMs: Long,
    nextAttemptAt: Long,
  ): Boolean {
    if (connectionPhase != ConnectionPhase.Connected) return false
    if (shellSyncPhase != SyncPhase.Synchronized) return false
    return nextAttemptAt <= nowMs
  }
}
