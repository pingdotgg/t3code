package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ProviderModel
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerModelLogicTest {
  @Test
  fun `current models stay visible while legacy models are separated`() {
    val sections = providerModelSections(
      listOf(model("gpt-5.6-sol"), model("gpt-5.4", isLegacy = true), model("gpt-5.6-terra")),
    )

    assertEquals(listOf("gpt-5.6-sol", "gpt-5.6-terra"), sections.current.map(ProviderModel::model))
    assertEquals(listOf("gpt-5.4"), sections.legacy.map(ProviderModel::model))
  }

  @Test
  fun `selected legacy model expands its provider section`() {
    val selected = model("gpt-5.4", isLegacy = true)

    assertEquals("codex", selectedLegacyModelInstance(selected))
    assertEquals(null, selectedLegacyModelInstance(model("gpt-5.6-sol")))
  }

  private fun model(slug: String, isLegacy: Boolean = false) = ProviderModel(
    instanceId = "codex",
    providerLabel = "Codex",
    model = slug,
    modelLabel = slug,
    isDefault = false,
    isLegacy = isLegacy,
    rawSelection = JsonObject(emptyMap()),
  )
}
