package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.RpcDefect
import com.t3tools.android.protocol.RpcFailure
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Test

class ErrorMessagesTest {
  private val json = Json

  @Test
  fun `remote branch and schema failures are actionable`() {
    val gitFailure = RpcFailure(
      json.parseToJsonElement(
        """[{"_tag":"Fail","error":{"message":"Git command failed in GitVcsDriver.resolveRemoteTrackingCommit"}}]""",
      ).jsonArray,
    )
    val schemaFailure = RpcDefect(json.parseToJsonElement("""{"message":"Expected command union"}"""))

    assertEquals(
      "The selected branch does not exist on origin. Turn off Start from origin or choose a remote branch.",
      gitFailure.safeMessage(),
    )
    assertEquals(
      "This action is not supported by the connected server. Update the server and try again.",
      schemaFailure.safeMessage(),
    )
  }
}
