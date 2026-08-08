package com.t3tools.android.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.t3tools.android.protocol.SavedCredential
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidCredentialStoreTest {
  @Test
  fun restores_bearer_credential_from_a_new_store_instance() = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val environmentId = "instrumented-environment"
    val expected = SavedCredential(
      environmentId = environmentId,
      httpBaseUrl = "https://environment.example.test/",
      accessToken = "secret-bearer-token",
    )
    val first = AndroidCredentialStore(context)
    first.clear(environmentId)

    first.save(expected)
    val restored = AndroidCredentialStore(context).load(environmentId)

    assertEquals(expected, restored)
    AndroidCredentialStore(context).clear(environmentId)
    assertNull(AndroidCredentialStore(context).load(environmentId))
  }
}
