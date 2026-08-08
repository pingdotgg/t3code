package com.t3tools.android.nativeapp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.t3tools.android.protocol.CredentialStore
import com.t3tools.android.protocol.SavedCredential
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json

class AndroidCredentialStore(
  context: Context,
  private val json: Json = Json,
) : CredentialStore {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  override suspend fun save(credential: SavedCredential) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(credential.environmentId.toByteArray())
    val encrypted = cipher.doFinal(json.encodeToString(SavedCredential.serializer(), credential).toByteArray())
    val payload = cipher.iv + encrypted
    check(preferences.edit().putString(storageKey(credential.environmentId), encode(payload)).commit()) {
      "Could not persist environment credential."
    }
  }

  override suspend fun load(environmentId: String): SavedCredential? {
    val payload = preferences.getString(storageKey(environmentId), null)?.let(::decode) ?: return null
    require(payload.size > IV_BYTES) { "Stored credential is malformed." }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.copyOfRange(0, IV_BYTES)))
    cipher.updateAAD(environmentId.toByteArray())
    val cleartext = cipher.doFinal(payload.copyOfRange(IV_BYTES, payload.size)).decodeToString()
    return json.decodeFromString(SavedCredential.serializer(), cleartext).also {
      require(it.environmentId == environmentId) { "Stored credential belongs to another environment." }
    }
  }

  override suspend fun clear(environmentId: String) {
    check(preferences.edit().remove(storageKey(environmentId)).commit()) {
      "Could not remove environment credential."
    }
  }

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(
        KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build(),
      )
      generateKey()
    }
  }

  private fun storageKey(environmentId: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(environmentId.toByteArray())
    return "credential_${Base64.encodeToString(digest, Base64.NO_WRAP or Base64.URL_SAFE)}"
  }

  private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)

  private companion object {
    const val PREFERENCES = "t3_native_credentials"
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "t3_native_environment_credentials"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
