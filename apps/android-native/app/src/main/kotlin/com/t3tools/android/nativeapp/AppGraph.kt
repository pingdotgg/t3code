package com.t3tools.android.nativeapp

import android.app.Application
import com.t3tools.android.protocol.T3ProtocolClient

class NativeAndroidApplication : Application() {
  lateinit var graph: AppGraph
    private set

  override fun onCreate() {
    super.onCreate()
    graph = AppGraph(this)
  }
}

class AppGraph(application: Application) {
  val credentialStore = AndroidCredentialStore(application)
  val environmentStore = EnvironmentStore(application)
  val draftStore = DraftStore(application)
  val chatRepository = OnlineChatRepository(
    client = T3ProtocolClient(credentialStore),
    credentialStore = credentialStore,
    environmentStore = environmentStore,
    draftStore = draftStore,
  )
}
