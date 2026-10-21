package expo.modules.t3composereditor

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import java.net.URL
import java.util.concurrent.Executors

internal object T3ChipIcons {
  private val images = HashMap<String, Bitmap>()
  private val pending = HashMap<String, MutableSet<(String) -> Unit>>()
  private val downloads = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  fun cached(uri: String): Bitmap? = images[uri]

  fun load(context: Context, uri: String, onLoaded: (String) -> Unit): Bitmap? =
    images[uri] ?: when {
      uri.isEmpty() -> null
      uri.startsWith("http://") || uri.startsWith("https://") -> {
        download(uri, onLoaded)
        null
      }
      else -> decodeLocal(context, uri)?.also { images[uri] = it }
    }

  private fun download(uri: String, onLoaded: (String) -> Unit) {
    val waiting = pending[uri]
    if (waiting != null) {
      waiting.add(onLoaded)
      return
    }
    pending[uri] = mutableSetOf(onLoaded)
    downloads.execute {
      val bitmap = runCatching {
        URL(uri).openStream().use(BitmapFactory::decodeStream)
      }.getOrNull()
      main.post {
        val callbacks = pending.remove(uri).orEmpty()
        if (bitmap != null) {
          images[uri] = bitmap
          callbacks.forEach { it(uri) }
        }
      }
    }
  }

  private fun decodeLocal(context: Context, uri: String): Bitmap? = runCatching {
    when {
      uri.startsWith("/") -> BitmapFactory.decodeFile(uri)
      uri.startsWith("file:") -> Uri.parse(uri).path?.let(BitmapFactory::decodeFile)
      else -> context.resources.getIdentifier(uri, "drawable", context.packageName)
        .takeIf { it != 0 }
        ?.let { BitmapFactory.decodeResource(context.resources, it) }
    }
  }.getOrNull()
}
