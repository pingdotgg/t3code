package com.t3tools.android.nativeapp

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.SvgDecoder
import com.clerk.api.Clerk
import com.t3tools.android.protocol.T3ProtocolClient

class NativeAndroidApplication : Application(), ImageLoaderFactory {
  lateinit var graph: AppGraph
    private set

  override fun onCreate() {
    super.onCreate()
    Clerk.initialize(this, BuildConfig.T3_CLERK_PUBLISHABLE_KEY)
    graph = AppGraph(this)
  }

  override fun newImageLoader() = ImageLoader.Builder(this)
    .components { add(SvgDecoder.Factory()) }
    .build()
}

class AppGraph(application: Application) {
  val database = NativeDatabase(application)
  val credentialStore = AndroidCredentialStore(application)
  val environmentStore = EnvironmentStore(application, database)
  val draftStore = DraftStore(application)
  val attachmentStore = AttachmentStore(application)
  val promptStashStore = PromptStashStore(application)
  val incomingShareStore = IncomingShareStore(application)
  val launcherShortcutStore = LauncherShortcutStore(application)
  val connectivity = AndroidConnectivity(application)
  private val protocolClient = T3ProtocolClient(credentialStore)
  val connectClient = T3ConnectClient(protocolClient)
  val chatRepository = OnlineChatRepository(
    client = protocolClient,
    connectClient = connectClient,
    credentialStore = credentialStore,
    environmentStore = environmentStore,
    draftStore = draftStore,
    attachmentStore = attachmentStore,
    database = database,
    connectivity = connectivity,
  )

  private val lifecycleObserver = object : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) = chatRepository.onForegrounded()
    override fun onStop(owner: LifecycleOwner) = chatRepository.onBackgrounded()
  }

  init {
    ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
  }
}
