package com.t3tools.android.protocol

import kotlinx.serialization.Serializable

@Serializable
data class SavedCredential(
  val environmentId: String,
  val httpBaseUrl: String,
  val accessToken: String,
)

interface CredentialStore {
  suspend fun save(credential: SavedCredential)
  suspend fun load(environmentId: String): SavedCredential?
  suspend fun clear(environmentId: String)
}

class InMemoryCredentialStore : CredentialStore {
  private val credentials = mutableMapOf<String, SavedCredential>()

  override suspend fun save(credential: SavedCredential) {
    credentials[credential.environmentId] = credential
  }

  override suspend fun load(environmentId: String) = credentials[environmentId]

  override suspend fun clear(environmentId: String) {
    credentials.remove(environmentId)
  }
}
