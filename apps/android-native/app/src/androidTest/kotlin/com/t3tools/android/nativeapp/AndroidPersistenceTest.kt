package com.t3tools.android.nativeapp

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidPersistenceTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private val environments = EnvironmentStore(context)
  private val drafts = DraftStore(context)

  @After
  fun cleanUp() {
    environments.load()?.let { drafts.clearEnvironment(it.environmentId) }
    environments.clear()
  }

  @Test
  fun restores_environment_and_draft_then_clears_them_together() {
    val environment = SavedEnvironment("environment-1", "Ubuntu", "http://100.64.0.1:8080")
    val key = DraftStore.threadKey(environment.environmentId, "thread-1")
    environments.save(environment)
    drafts.save(key, ComposerDraft(text = "Keep this", interactionMode = "plan"))

    assertEquals(environment, environments.load())
    assertEquals("Keep this", drafts.load(key).text)

    drafts.clearEnvironment(environment.environmentId)
    environments.clear()
    assertNull(environments.load())
    assertEquals(ComposerDraft(), drafts.load(key))
  }
}
