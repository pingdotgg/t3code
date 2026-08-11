package com.t3tools.android.nativeapp

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

class MainActivity : ComponentActivity() {
  private val viewModel by viewModels<AppViewModel> {
    AppViewModel.Factory((application as NativeAndroidApplication).graph)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      val runtime by viewModel.runtime.collectAsState()
      T3NativeTheme(runtime.settings) {
        T3NativeApp(viewModel)
      }
    }
    if (savedInstanceState == null) viewModel.handleSystemIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    viewModel.handleSystemIntent(intent)
  }
}
