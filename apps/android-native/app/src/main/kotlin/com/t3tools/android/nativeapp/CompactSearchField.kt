package com.t3tools.android.nativeapp

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Clear
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

@Composable
internal fun CompactSearchField(
  value: String,
  onValueChange: (String) -> Unit,
  placeholder: String,
  modifier: Modifier = Modifier,
) {
  CompactInputField(
    value = value,
    onValueChange = onValueChange,
    placeholder = placeholder,
    leadingIcon = Icons.Rounded.Search,
    trailingIcon = Icons.Rounded.Clear.takeIf { value.isNotEmpty() },
    trailingContentDescription = "Clear search",
    onTrailingClick = { onValueChange("") },
    imeAction = ImeAction.Search,
    modifier = modifier,
  )
}

@Composable
internal fun CompactInputField(
  value: String,
  onValueChange: (String) -> Unit,
  placeholder: String,
  modifier: Modifier = Modifier,
  leadingIcon: ImageVector? = null,
  trailingIcon: ImageVector? = null,
  trailingContentDescription: String? = null,
  onTrailingClick: (() -> Unit)? = null,
  imeAction: ImeAction = ImeAction.Done,
  enabled: Boolean = true,
) {
  val interactionSource = remember { MutableInteractionSource() }
  val focused by interactionSource.collectIsFocusedAsState()
  val focusManager = LocalFocusManager.current
  val keyboard = LocalSoftwareKeyboardController.current
  val colors = MaterialTheme.colorScheme

  Surface(
    modifier = modifier.height(44.dp),
    shape = RoundedCornerShape(14.dp),
    color = colors.surfaceContainerHigh.copy(alpha = if (enabled) 1f else 0.55f),
    border = BorderStroke(
      1.dp,
      if (focused) colors.primary.copy(alpha = 0.7f) else colors.outlineVariant.copy(alpha = 0.55f),
    ),
  ) {
    Row(
      modifier = Modifier.padding(start = 12.dp, end = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      leadingIcon?.let {
        Icon(
          imageVector = it,
          contentDescription = null,
          tint = colors.onSurfaceVariant,
          modifier = Modifier.size(19.dp),
        )
      }
      Box(
        modifier = Modifier
          .weight(1f)
          .padding(horizontal = if (leadingIcon == null) 2.dp else 10.dp),
        contentAlignment = Alignment.CenterStart,
      ) {
        if (value.isEmpty()) {
          Text(
            placeholder,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant.copy(alpha = 0.72f),
          )
        }
        BasicTextField(
          value = value,
          onValueChange = onValueChange,
          enabled = enabled,
          singleLine = true,
          interactionSource = interactionSource,
          textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.onSurface),
          cursorBrush = SolidColor(colors.primary),
          keyboardOptions = KeyboardOptions(imeAction = imeAction),
          keyboardActions = KeyboardActions(
            onSearch = {
              focusManager.clearFocus()
              keyboard?.hide()
            },
            onDone = {
              focusManager.clearFocus()
              keyboard?.hide()
            },
          ),
          modifier = Modifier.fillMaxWidth(),
        )
      }
      if (trailingIcon != null && onTrailingClick != null) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
          IconButton(
            onClick = onTrailingClick,
            enabled = enabled,
            modifier = Modifier.size(32.dp),
          ) {
            Icon(
              imageVector = trailingIcon,
              contentDescription = trailingContentDescription,
              tint = colors.onSurfaceVariant,
              modifier = Modifier.size(17.dp),
            )
          }
        }
      }
    }
  }
}
