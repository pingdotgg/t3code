package com.t3tools.android.protocol

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class PairingTarget(
  val credential: String,
  val httpBaseUrl: String,
  val wsBaseUrl: String,
)

object PairingTargetParser {
  fun parse(pairingUrl: String): PairingTarget {
    val url = URI(pairingUrl.trim())
    require(url.scheme in setOf("http", "https", "ws", "wss")) {
      "Unsupported pairing URL scheme: ${url.scheme}"
    }

    val query = parameters(url.rawQuery)
    val fragment = parameters(url.rawFragment)
    val credential = fragment["token"]?.trim().orEmpty()
      .ifEmpty { query["token"]?.trim().orEmpty() }
    require(credential.isNotEmpty()) { "Pairing URL is missing its token." }

    val hostedTarget = query["host"]?.trim().orEmpty()
    val backend = if (hostedTarget.isEmpty()) url else normalizeUri(hostedTarget)
    require(backend.host != null) { "Pairing URL is missing its host." }

    val httpScheme = if (backend.scheme in setOf("https", "wss")) "https" else "http"
    val wsScheme = if (httpScheme == "https") "wss" else "ws"
    val authority = backend.rawAuthority
    return PairingTarget(
      credential = credential,
      httpBaseUrl = URI(httpScheme, authority, "/", null, null).toString(),
      wsBaseUrl = URI(wsScheme, authority, "/", null, null).toString(),
    )
  }

  private fun normalizeUri(value: String): URI {
    val normalized = value.trim().replace(Regex("^/+"), "")
    val withScheme = if (normalized.contains("://")) normalized else "https://$normalized"
    return URI(withScheme)
  }

  private fun parameters(value: String?): Map<String, String> = value
    ?.split('&')
    ?.filter { it.isNotEmpty() }
    ?.associate { entry ->
      val (key, encodedValue) = entry.split('=', limit = 2).let {
        it.first() to it.getOrElse(1) { "" }
      }
      decode(key) to decode(encodedValue)
    }
    .orEmpty()

  private fun decode(value: String) = URLDecoder.decode(value, StandardCharsets.UTF_8)
}
