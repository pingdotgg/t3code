package expo.modules.t3nativecontrols

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.text.format.DateFormat
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class T3NativeControlsModule : Module() {
  private var filePreviewPromise: Promise? = null

  @Suppress("TooGenericExceptionCaught") // Clear the pending promise before rethrowing.
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")

    Function("is24HourFormat") {
      val context = appContext.reactContext ?: error("The app is not active.")
      DateFormat.is24HourFormat(context)
    }

    AsyncFunction("openFile") { uri: String, mimeType: String, promise: Promise ->
      check(filePreviewPromise == null) { "A document viewer is already open." }
      val activity = appContext.currentActivity ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.isFile) { "The file is no longer available." }
      val contentUri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.FileSystemFileProvider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      filePreviewPromise = promise
      try {
        activity.startActivityForResult(intent, 7343)
      } catch (error: Exception) {
        filePreviewPromise = null
        throw error
      }
    }

    AsyncFunction("saveImageToLibrary") { uri: String, mimeType: String, name: String ->
      val context = appContext.reactContext ?: error("The app is not active.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveImageToPictures(context, Uri.parse(uri), mimeType, name)
      } else {
        error("Saving images needs Android 10 or later.")
      }
    }

    OnActivityResult { _, (requestCode) ->
      if (requestCode == 7343) {
        filePreviewPromise?.resolve(null)
        filePreviewPromise = null
      }
    }

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch extra — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") {
      appContext.currentActivity?.intent?.getStringExtra("showcaseTheme")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-ready")
        ?.writeText(scene)
    }
  }
}

// Android 10+ lets apps add their own media without a storage permission.
@RequiresApi(Build.VERSION_CODES.Q)
@Suppress("TooGenericExceptionCaught") // Remove the pending entry before rethrowing.
private fun saveImageToPictures(context: Context, source: Uri, mimeType: String, name: String) {
  val resolver = context.contentResolver
  val values = ContentValues().apply {
    put(MediaStore.Images.Media.DISPLAY_NAME, name)
    put(MediaStore.Images.Media.MIME_TYPE, mimeType)
    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/T3 Code")
    put(MediaStore.Images.Media.IS_PENDING, 1)
  }
  val target = resolver.insert(
    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
    values
  ) ?: error("Could not create the image in Pictures.")
  try {
    val input = resolver.openInputStream(source) ?: error("The image is no longer available.")
    input.use { from ->
      val output = resolver.openOutputStream(target) ?: error("Could not write the image.")
      output.use { from.copyTo(it) }
    }
    resolver.update(
      target,
      ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
      null,
      null
    )
  } catch (error: Exception) {
    resolver.delete(target, null, null)
    throw error
  }
}
