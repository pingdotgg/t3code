package expo.modules.t3terminal

internal object GhosttyBridge {
  init {
    System.loadLibrary("ghostty-vt")
    System.loadLibrary("t3terminal")
  }

  @JvmStatic
  @Suppress("LongParameterList")
  external fun nativeCreate(
    cols: Int,
    rows: Int,
    cellWidth: Int,
    cellHeight: Int,
    foreground: Int,
    background: Int,
    cursor: Int,
    palette: IntArray
  ): Long

  @JvmStatic external fun nativeDestroy(handle: Long)

  @JvmStatic external fun nativeFeed(handle: Long, data: ByteArray): ByteArray

  @JvmStatic
  external fun nativeResize(
    handle: Long,
    cols: Int,
    rows: Int,
    cellWidth: Int,
    cellHeight: Int
  ): ByteArray

  @JvmStatic external fun nativeScroll(handle: Long, rows: Int)

  @JvmStatic
  external fun nativeSetTheme(
    handle: Long,
    foreground: Int,
    background: Int,
    cursor: Int,
    palette: IntArray
  )

  @JvmStatic external fun nativeSnapshot(handle: Long): ByteArray

  @JvmStatic external fun nativeSelectWordAt(handle: Long, col: Int, row: Int): Boolean

  @JvmStatic
  external fun nativeExtendSelection(
    handle: Long,
    anchorCol: Int,
    anchorRow: Int,
    col: Int,
    row: Int
  )

  @JvmStatic external fun nativeSelectAll(handle: Long): Boolean

  @JvmStatic external fun nativeClearSelection(handle: Long)

  @JvmStatic external fun nativeGetSelectionText(handle: Long): ByteArray?
}
