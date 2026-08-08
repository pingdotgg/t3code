package com.t3tools.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable
data class EnvironmentDescriptor(
  val environmentId: String,
  val label: String,
  val serverVersion: String,
  val capabilities: JsonObject,
)

@Serializable
private data class AccessTokenResponse(
  @SerialName("access_token") val accessToken: String,
  @SerialName("token_type") val tokenType: String,
)

@Serializable
private data class WebSocketTicketResponse(val ticket: String)

data class PairingResult(
  val target: PairingTarget,
  val descriptor: EnvironmentDescriptor,
  val credential: SavedCredential,
)

class AuthClient(
  private val http: OkHttpClient,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  fun pair(pairingUrl: String): PairingResult {
    val target = PairingTargetParser.parse(pairingUrl)
    val descriptor = fetchDescriptor(target.httpBaseUrl)
    val accessToken = exchangeBootstrapCredential(target.httpBaseUrl, target.credential)
    return PairingResult(
      target = target,
      descriptor = descriptor,
      credential = SavedCredential(
        environmentId = descriptor.environmentId,
        httpBaseUrl = target.httpBaseUrl,
        accessToken = accessToken,
      ),
    )
  }

  fun fetchDescriptor(httpBaseUrl: String): EnvironmentDescriptor {
    val request = Request.Builder()
      .url(endpoint(httpBaseUrl, "/.well-known/t3/environment"))
      .get()
      .build()
    return execute(request) { json.decodeFromString(it) }
  }

  fun issueWebSocketUrl(credential: SavedCredential): String {
    val request = Request.Builder()
      .url(endpoint(credential.httpBaseUrl, "/api/auth/websocket-ticket"))
      .header("Authorization", "Bearer ${credential.accessToken}")
      .post(FormBody.Builder().build())
      .build()
    val ticket = execute(request) {
      json.decodeFromString<WebSocketTicketResponse>(it).ticket
    }
    val base = credential.httpBaseUrl.toHttpUrl()
    val socketScheme = if (base.isHttps) "wss" else "ws"
    val ticketUrl = base.newBuilder()
      .encodedPath("/ws")
      .query(null)
      .addQueryParameter("wsTicket", ticket)
      .build()
      .toString()
    return ticketUrl.replaceBefore("://", socketScheme)
  }

  private fun exchangeBootstrapCredential(httpBaseUrl: String, credential: String): String {
    val body = FormBody.Builder()
      .add("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")
      .add("subject_token", credential)
      .add("subject_token_type", "urn:t3:params:oauth:token-type:environment-bootstrap")
      .add("requested_token_type", "urn:ietf:params:oauth:token-type:access_token")
      .add(
        "scope",
        "orchestration:read orchestration:operate terminal:operate review:write relay:read",
      )
      .add("client_label", "T3 Code Native")
      .add("client_device_type", "mobile")
      .add("client_os", "android")
      .build()
    val request = Request.Builder()
      .url(endpoint(httpBaseUrl, "/oauth/token"))
      .post(body)
      .build()
    return execute(request) {
      val response = json.decodeFromString<AccessTokenResponse>(it)
      require(response.tokenType == "Bearer") { "Server did not issue a bearer token." }
      response.accessToken
    }
  }

  private fun endpoint(baseUrl: String, path: String) =
    requireNotNull(baseUrl.toHttpUrl().resolve(path)) { "Invalid environment endpoint: $path" }

  private fun <T> execute(request: Request, decode: (String) -> T): T =
    http.newCall(request).execute().use { response ->
      val body = response.body?.string().orEmpty()
      check(response.isSuccessful) {
        "${request.method} ${request.url.encodedPath} failed with HTTP ${response.code}."
      }
      decode(body)
    }
}
