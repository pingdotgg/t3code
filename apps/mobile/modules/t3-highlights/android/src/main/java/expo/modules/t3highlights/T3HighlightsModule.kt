package expo.modules.t3highlights

import expo.modules.kotlin.jni.ArrayBuffer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder

class T3HighlightsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3Highlights")

    Function("tokenize") { source: String, language: Int ->
      HighlightsNative.tokenize(source, language)
    }
  }
}

internal object HighlightsNative {
  init {
    System.loadLibrary("t3highlights")
  }

  // The records live in the lexer's memory until its next run.
  @Synchronized
  fun tokenize(source: String, language: Int): ArrayBuffer? {
    val count = nativeTokenize(source.toByteArray(Charsets.UTF_8), language)
    if (count < 0) return null
    val records = ByteBuffer.allocateDirect(count * Int.SIZE_BYTES).order(ByteOrder.nativeOrder())
    nativeCopyRecords(records)
    return ArrayBuffer(records)
  }

  @JvmStatic private external fun nativeTokenize(source: ByteArray, language: Int): Int

  @JvmStatic private external fun nativeCopyRecords(destination: ByteBuffer)
}
