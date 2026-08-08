package com.t3tools.android.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
  private val viewModel by viewModels<AppViewModel> {
    AppViewModel.Factory((application as NativeAndroidApplication).graph)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      T3NativeTheme {
        T3NativeApp(viewModel)
      }
    }
  }
}
