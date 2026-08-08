package com.t3tools.android.nativeapp

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.fetchToken
import com.t3tools.android.protocol.ConnectedEnvironment
import com.t3tools.android.protocol.T3ProtocolClient
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class RelayEndpoint(
  val httpBaseUrl: String,
  val wsBaseUrl: String,
  val providerKind: String,
)

@Serializable
data class RelayEnvironment(
  val environmentId: String,
  val label: String,
  val endpoint: RelayEndpoint,
  val linkedAt: String,
)

@Serializable
private data class RelayEnvironmentList(val environments: List<RelayEnvironment>)

@Serializable
private data class RelayDpopTokenResponse(
  @SerialName("access_token") val accessToken: String,
  @SerialName("token_type") val tokenType: String,
  @SerialName("expires_in") val expiresIn: Int,
  val scope: String,
)

@Serializable
private data class RelayConnectResponse(
  val environmentId: String,
  val endpoint: RelayEndpoint,
  val credential: String,
  val expiresAt: String,
)

@Serializable
private data class EnvironmentAccessTokenResponse(
  @SerialName("access_token") val accessToken: String,
  @SerialName("token_type") val tokenType: String,
)

@Serializable
private data class WebSocketTicketResponse(val ticket: String)

class T3ConnectClient(
  private val protocol: T3ProtocolClient,
  private val http: OkHttpClient = OkHttpClient(),
  private val relayUrl: String = BuildConfig.T3_RELAY_URL,
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val signer: AndroidDpopSigner = AndroidDpopSigner(),
) : AutoCloseable {
  private val tokenMutex = Mutex()
  private var relayToken: CachedRelayToken? = null

  suspend fun listEnvironments(): List<RelayEnvironment> {
    val clerkToken = clerkToken()
    val request = Request.Builder()
      .url(endpoint(relayUrl, "/v1/environments"))
      .header("Authorization", "Bearer $clerkToken")
      .get()
      .build()
    return execute(request) { json.decodeFromString<RelayEnvironmentList>(it).environments }
  }

  suspend fun connect(environmentId: String, accountId: String): ConnectedEnvironment {
    val clerkToken = clerkToken()
    val relayAccess = relayAccessToken(accountId, clerkToken, setOf(ENVIRONMENT_CONNECT_SCOPE))
    val connectUrl = endpoint(relayUrl, "/v1/environments/${encodePath(environmentId)}/connect")
    val connectProof = signer.proof("POST", connectUrl, relayAccess.token)
    val connectBody = json.encodeToString(
      JsonObject.serializer(),
      JsonObject(
        mapOf(
          "clientProofKeyThumbprint" to kotlinx.serialization.json.JsonPrimitive(signer.thumbprint),
        ),
      ),
    ).toRequestBody(JSON_MEDIA_TYPE)
    val connected = execute(
      Request.Builder()
        .url(connectUrl)
        .header("Authorization", "DPoP ${relayAccess.token}")
        .header("DPoP", connectProof)
        .post(connectBody)
        .build(),
    ) { json.decodeFromString<RelayConnectResponse>(it) }
    require(connected.environmentId == environmentId) {
      "Relay returned a different environment id."
    }

    val descriptor = protocol.fetchDescriptor(connected.endpoint.httpBaseUrl)
    require(descriptor.environmentId == environmentId) {
      "Relay endpoint descriptor belongs to another environment."
    }
    val access = exchangeEnvironmentAccessToken(connected)
    val ticketUrl = endpoint(connected.endpoint.httpBaseUrl, "/api/auth/websocket-ticket")
    val ticketProof = signer.proof("POST", ticketUrl, access)
    val ticket = execute(
      Request.Builder()
        .url(ticketUrl)
        .header("Authorization", "DPoP $access")
        .header("DPoP", ticketProof)
        .post(FormBody.Builder().build())
        .build(),
    ) { json.decodeFromString<WebSocketTicketResponse>(it).ticket }
    val socketScheme = when {
      connected.endpoint.wsBaseUrl.startsWith("https://") -> "wss"
      connected.endpoint.wsBaseUrl.startsWith("http://") -> "ws"
      else -> connected.endpoint.wsBaseUrl.substringBefore("://")
    }
    val socketOrigin = connected.endpoint.wsBaseUrl.substringAfter("://").trimEnd('/').substringBefore('/')
    val socketUrl = "$socketScheme://$socketOrigin/ws?wsTicket=${encodePath(ticket)}"
    return protocol.connectWithSocket(descriptor, socketUrl)
  }

  fun reset() {
    relayToken = null
  }

  private suspend fun clerkToken(): String {
    val session = requireNotNull(Clerk.activeSession) { "Sign in to T3 Connect." }
    return when (
      val result = session.fetchToken(GetTokenOptions(template = BuildConfig.T3_CLERK_JWT_TEMPLATE))
    ) {
      is ClerkResult.Success -> result.value.jwt
      is ClerkResult.Failure -> error(result.error.toString())
    }
  }

  private suspend fun relayAccessToken(
    accountId: String,
    clerkToken: String,
    scopes: Set<String>,
  ): CachedRelayToken = tokenMutex.withLock {
    val now = System.currentTimeMillis()
    relayToken?.takeIf {
      it.accountId == accountId &&
        it.thumbprint == signer.thumbprint &&
        it.scopes == scopes &&
        it.expiresAt > now + 5_000
    }?.let { return@withLock it }

    val tokenUrl = endpoint(relayUrl, "/v1/client/dpop-token")
    val response = execute(
      Request.Builder()
        .url(tokenUrl)
        .header("DPoP", signer.proof("POST", tokenUrl))
        .post(
          FormBody.Builder()
            .add("grant_type", TOKEN_EXCHANGE_GRANT)
            .add("subject_token", clerkToken)
            .add("subject_token_type", JWT_SUBJECT_TOKEN)
            .add("requested_token_type", ACCESS_TOKEN_TYPE)
            .add("resource", relayUrl)
            .add("scope", scopes.sorted().joinToString(" "))
            .add("client_id", "t3-mobile")
            .build(),
        )
        .build(),
    ) { json.decodeFromString<RelayDpopTokenResponse>(it) }
    require(response.tokenType == "DPoP") { "Relay did not issue a DPoP token." }
    require(response.scope.split(' ').filter(String::isNotBlank).toSet() == scopes) {
      "Relay granted unexpected scopes."
    }
    CachedRelayToken(
      accountId = accountId,
      token = response.accessToken,
      thumbprint = signer.thumbprint,
      scopes = scopes,
      expiresAt = now + response.expiresIn * 1_000L,
    ).also { relayToken = it }
  }

  private fun exchangeEnvironmentAccessToken(connected: RelayConnectResponse): String {
    val tokenUrl = endpoint(connected.endpoint.httpBaseUrl, "/oauth/token")
    val request = Request.Builder()
      .url(tokenUrl)
      .header("DPoP", signer.proof("POST", tokenUrl))
      .post(
        FormBody.Builder()
          .add("grant_type", TOKEN_EXCHANGE_GRANT)
          .add("subject_token", connected.credential)
          .add("subject_token_type", ENVIRONMENT_BOOTSTRAP_TOKEN)
          .add("requested_token_type", ACCESS_TOKEN_TYPE)
          .add("scope", STANDARD_ENVIRONMENT_SCOPES)
          .add("client_label", "T3 Code Native")
          .add("client_device_type", "mobile")
          .add("client_os", "android")
          .build(),
      )
      .build()
    val response = execute(request) { json.decodeFromString<EnvironmentAccessTokenResponse>(it) }
    require(response.tokenType == "DPoP") { "Environment did not issue a DPoP token." }
    return response.accessToken
  }

  private fun endpoint(baseUrl: String, path: String) = requireNotNull(
    baseUrl.toHttpUrl().resolve(path),
  ) { "Invalid T3 Connect endpoint: $path" }.toString()

  private fun <T> execute(request: Request, decode: (String) -> T): T =
    http.newCall(request).execute().use { response ->
      val body = response.body?.string().orEmpty()
      check(response.isSuccessful) {
        val trace = response.header("x-trace-id") ?: response.header("traceparent")
        buildString {
          append("${request.method} ${request.url.encodedPath} failed with HTTP ${response.code}.")
          if (!trace.isNullOrBlank()) append(" Trace: ${trace.take(120)}")
        }
      }
      decode(body)
    }

  override fun close() {
    http.dispatcher.executorService.shutdown()
    http.connectionPool.evictAll()
  }

  private data class CachedRelayToken(
    val accountId: String,
    val token: String,
    val thumbprint: String,
    val scopes: Set<String>,
    val expiresAt: Long,
  )

  private companion object {
    val JSON_MEDIA_TYPE = "application/json".toMediaType()
    const val ENVIRONMENT_CONNECT_SCOPE = "environment:connect"
    const val TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
    const val JWT_SUBJECT_TOKEN = "urn:ietf:params:oauth:token-type:jwt"
    const val ENVIRONMENT_BOOTSTRAP_TOKEN = "urn:t3:params:oauth:token-type:environment-bootstrap"
    const val ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
    const val STANDARD_ENVIRONMENT_SCOPES =
      "orchestration:read orchestration:operate terminal:operate review:write relay:read"
  }
}

class AndroidDpopSigner {
  private val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
  private val publicKey: ECPublicKey
    get() = keyStore.getCertificate(KEY_ALIAS).publicKey as ECPublicKey

  init {
    if (!keyStore.containsAlias(KEY_ALIAS)) {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
        initialize(
          KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
          )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .build(),
        )
        generateKeyPair()
      }
    }
  }

  private val jwk: DpopJwk by lazy {
    DpopJwk(
      x = DpopCrypto.base64Url(DpopCrypto.bigIntegerToUnsigned(publicKey.w.affineX, 32)),
      y = DpopCrypto.base64Url(DpopCrypto.bigIntegerToUnsigned(publicKey.w.affineY, 32)),
    )
  }

  val thumbprint: String by lazy { DpopCrypto.jwkThumbprint(jwk.x, jwk.y) }

  fun proof(method: String, url: String, accessToken: String? = null): String {
    val header = DPOP_JSON.encodeToString(
      DpopHeader.serializer(),
      DpopHeader(jwk = jwk),
    )
    val normalized = url.toHttpUrl().newBuilder()
      .query(null)
      .fragment(null)
      .build()
      .toString()
    val payload = DPOP_JSON.encodeToString(
      DpopPayload.serializer(),
      DpopPayload(
        htm = method.uppercase(),
        htu = normalized,
        jti = UUID.randomUUID().toString(),
        iat = System.currentTimeMillis() / 1_000,
        ath = accessToken?.let(DpopCrypto::accessTokenHash),
      ),
    )
    val unsigned =
      "${DpopCrypto.base64Url(header.toByteArray())}.${DpopCrypto.base64Url(payload.toByteArray())}"
    val signature = Signature.getInstance("SHA256withECDSA").run {
      initSign(keyStore.getKey(KEY_ALIAS, null) as java.security.PrivateKey)
      update(unsigned.toByteArray())
      DpopCrypto.derEcdsaToJose(sign())
    }
    return "$unsigned.${DpopCrypto.base64Url(signature)}"
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "t3_native_cloud_dpop_p256"
    val DPOP_JSON = Json { explicitNulls = false }
  }
}

@Serializable
private data class DpopJwk(
  val kty: String = "EC",
  val crv: String = "P-256",
  val x: String,
  val y: String,
)

@Serializable
private data class DpopHeader(
  val typ: String = "dpop+jwt",
  val alg: String = "ES256",
  val jwk: DpopJwk,
)

@Serializable
private data class DpopPayload(
  val htm: String,
  val htu: String,
  val jti: String,
  val iat: Long,
  val ath: String? = null,
)

private fun encodePath(value: String) = java.net.URLEncoder.encode(value, Charsets.UTF_8)
