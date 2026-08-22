package com.t3tools.android.protocol

import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class AuthClientTest {
  @Test
  fun exchanges_bootstrap_once_and_uses_bearer_for_a_socket_ticket() {
    val server = MockWebServer()
    server.enqueue(
      MockResponse().setBody(
        """{"environmentId":"env-1","label":"Test","platform":{"os":"linux","arch":"x64"},"serverVersion":"test","capabilities":{}}""",
      ),
    )
    server.enqueue(
      MockResponse().setBody(
        """{"access_token":"saved-token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":3600,"scope":"orchestration:read"}""",
      ),
    )
    server.enqueue(
      MockResponse().setBody(
        """{"ticket":"short-ticket","expiresAt":"2026-08-08T00:01:00.000Z"}""",
      ),
    )
    server.start()
    try {
      val auth = AuthClient(OkHttpClient())
      val result = auth.pair("${server.url("/pair")}#token=one-time")
      val socketUrl = auth.issueWebSocketUrl(result.credential)

      val descriptor = server.takeRequest()
      val exchange = server.takeRequest()
      val ticket = server.takeRequest()
      assertEquals("/.well-known/t3/environment", descriptor.path)
      assertEquals("/oauth/token", exchange.path)
      val form = URLDecoder.decode(exchange.body.readUtf8(), Charsets.UTF_8)
      assertTrue(form.contains("subject_token=one-time"))
      assertFalse(form.contains("saved-token"))
      assertEquals("Bearer saved-token", ticket.getHeader("Authorization"))
      assertEquals("/api/auth/websocket-ticket", ticket.path)
      assertTrue(socketUrl.startsWith("ws://"))
      assertTrue(socketUrl.endsWith("/ws?wsTicket=short-ticket"))
    } finally {
      server.shutdown()
    }
  }
}
