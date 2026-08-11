package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.RpcDefect
import com.t3tools.android.protocol.RpcTransportException

internal fun Throwable.safeMessage(): String {
  val detail = message.orEmpty()
  return when {
    "resolveRemoteTrackingCommit" in detail ->
      "The selected branch does not exist on origin. Turn off Start from origin or choose a remote branch."
    this is RpcDefect ->
      "This action is not supported by the connected server. Update the server and try again."
    this is RpcTransportException ->
      "The connection was interrupted. Try again."
    detail.isNotBlank() -> detail.lineSequence().first().take(240)
    else -> "Unexpected failure."
  }
}
