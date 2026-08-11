package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.ProviderModel

internal data class ProviderModelSections(
  val current: List<ProviderModel>,
  val legacy: List<ProviderModel>,
)

internal fun providerModelSections(models: List<ProviderModel>) = ProviderModelSections(
  current = models.filterNot(ProviderModel::isLegacy),
  legacy = models.filter(ProviderModel::isLegacy),
)

internal fun selectedLegacyModelInstance(model: ProviderModel?): String? =
  model?.instanceId?.takeIf { model.isLegacy }
