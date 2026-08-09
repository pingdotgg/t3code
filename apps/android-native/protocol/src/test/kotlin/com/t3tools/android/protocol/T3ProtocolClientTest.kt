package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class T3ProtocolClientTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun reconnect_adopts_the_server_environment_identity_after_a_successful_handshake() = runBlocking {
    val server = MockWebServer()
    server.enqueue(
      MockResponse().setBody(
        """{"environmentId":"env-new","label":"Current server","serverVersion":"test","capabilities":{}}""",
      ),
    )
    server.enqueue(MockResponse().setBody("""{"ticket":"socket-ticket"}"""))
    server.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onMessage(webSocket: WebSocket, text: String) {
            val request = json.parseToJsonElement(text).jsonObject
            if (request["tag"] == JsonPrimitive("server.getConfig")) {
              webSocket.send(
                """{"_tag":"Exit","requestId":${request["id"]},"exit":{"_tag":"Success","value":{"environment":{"environmentId":"env-new"}}}}""",
              )
            }
          }

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
          }
        },
      ),
    )
    server.start()
    val store = InMemoryCredentialStore()
    store.save(SavedCredential("env-old", server.url("/").toString(), "saved-token"))
    val client = T3ProtocolClient(store)

    try {
      val connected = client.reconnect("env-old")

      assertEquals("env-new", connected.descriptor.environmentId)
      assertNull(store.load("env-old"))
      assertEquals("env-new", store.load("env-new")?.environmentId)
      val descriptorRequest = server.takeRequest()
      val ticketRequest = server.takeRequest()
      assertEquals("/.well-known/t3/environment", descriptorRequest.path)
      assertEquals("Bearer saved-token", ticketRequest.getHeader("Authorization"))
      connected.session.close()
    } finally {
      client.close()
      server.shutdown()
    }
  }
}
