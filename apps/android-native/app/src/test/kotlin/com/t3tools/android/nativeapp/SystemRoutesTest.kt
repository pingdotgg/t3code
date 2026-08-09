package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SystemRoutesTest {
  @Test
  fun accepts_only_supported_app_routes() {
    assertEquals(SystemRoute.AddEnvironment, parseSystemRoute("t3code-native://connections/new"))
    assertEquals(SystemRoute.NewTask, parseSystemRoute("t3code-native://new"))
    assertEquals(
      SystemRoute.Thread("environment-1", "thread-2"),
      parseSystemRoute("t3code-native://threads/environment-1/thread-2"),
    )

    listOf(
      "https://threads/environment-1/thread-2",
      "t3code-native://threads/environment-1",
      "t3code-native://threads/environment-1/thread-2/extra",
      "t3code-native://threads/environment-1/thread-2/",
      "t3code-native://new/",
      "t3code-native://threads/environment-1/thread-2?admin=true",
      "t3code-native://connections/remove",
      "not a uri",
    ).forEach { assertNull(it, parseSystemRoute(it)) }
  }

  @Test
  fun accepts_supported_share_payloads_and_rejects_other_intents() {
    assertEquals(
      IncomingShareRequest("hello", emptyList(), null),
      buildIncomingShareRequest("android.intent.action.SEND", "text/plain", " hello ", emptyList()),
    )
    assertEquals(
      IncomingShareRequest("caption", listOf("content://first"), "image/png"),
      buildIncomingShareRequest(
        "android.intent.action.SEND",
        "image/PNG",
        "caption",
        listOf("content://first", "content://second"),
      ),
    )
    assertEquals(
      listOf("content://first", "content://second"),
      buildIncomingShareRequest(
        "android.intent.action.SEND_MULTIPLE",
        "image/jpeg",
        null,
        listOf("content://first", "content://first", "content://second"),
      )?.imageUris,
    )
    assertNull(buildIncomingShareRequest("android.intent.action.SEND", "application/pdf", "x", emptyList()))
    assertNull(buildIncomingShareRequest("android.intent.action.VIEW", "text/plain", "x", emptyList()))
  }

  @Test
  fun appends_shared_text_without_overwriting_the_draft() {
    assertEquals("draft\n\nshared", mergeSharedText("draft", "shared"))
    assertEquals("shared", mergeSharedText("", "shared"))
    assertEquals("draft", mergeSharedText("draft", ""))
  }
}
