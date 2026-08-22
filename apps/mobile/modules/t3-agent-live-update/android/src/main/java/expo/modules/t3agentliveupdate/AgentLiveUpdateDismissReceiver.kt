package expo.modules.t3agentliveupdate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

internal class AgentLiveUpdateDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    AgentLiveUpdateManager(context.applicationContext).cancel()
  }
}
