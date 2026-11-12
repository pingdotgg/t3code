package expo.modules.t3reviewdiff

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** A native selection stays within its file while its handles cross or skip hunk headers. */
internal class ReviewDiffLineRange {
  var startIndex: Int? = null
    private set
  var endIndex: Int? = null
    private set
  var isDragging = false
  var selectedRowIds: Set<String> = emptySet()
    private set
  private var lineIndices = emptyList<Int>()

  fun begin(index: Int, rows: List<DiffRow>): Boolean {
    if (index !in rows.indices) return false
    val fileId = rows[index].resolvedFileId
    lineIndices = rows.indices.filter {
      rows[it].kind == "line" && rows[it].resolvedFileId == fileId
    }
    isDragging = true
    return true
  }

  fun dragHandle(movingStart: Boolean): Boolean {
    val start = startIndex
    val end = endIndex
    if (start == null || end == null) return false
    startIndex = if (movingStart) max(start, end) else min(start, end)
    endIndex = if (movingStart) min(start, end) else max(start, end)
    isDragging = true
    return true
  }

  fun update(start: Int, end: Int, rows: List<DiffRow>): Pair<String, String>? {
    if (start !in rows.indices || end !in rows.indices) return null
    val validEnd = rows[end].kind == "line" &&
      rows[start].resolvedFileId == rows[end].resolvedFileId
    return if (!validEnd || (startIndex == start && endIndex == end)) {
      null
    } else {
      startIndex = start
      endIndex = end
      val first = min(start, end)
      val last = max(start, end)
      selectedRowIds = lineIndices.asSequence()
        .filter { it in first..last }.map { rows[it].id }.toSet()
      rows[first].id to rows[last].id
    }
  }

  fun nearestLine(index: Int): Int {
    if (lineIndices.isEmpty()) return index
    val target = index.coerceIn(lineIndices.first(), lineIndices.last())
    val at = lineIndices.binarySearch(target)
    return lineIndices[if (at >= 0) at else (-at - 1).coerceAtMost(lineIndices.lastIndex)]
  }

  fun clear() {
    isDragging = false
    startIndex = null
    endIndex = null
    lineIndices = emptyList()
    selectedRowIds = emptySet()
  }

  fun centers(
    rows: List<DiffRow>,
    rowOffsets: IntArray,
    verticalOffset: Int,
    x: Float
  ): Pair<Pair<Float, Float>, Pair<Float, Float>>? = startIndex?.let { start ->
    endIndex?.let { end ->
      if (start in rows.indices && end in rows.indices) {
        val bottomIndex = (max(start, end) + 1).coerceAtMost(rowOffsets.lastIndex)
        Pair(x, (rowOffsets[min(start, end)] - verticalOffset).toFloat()) to
          Pair(x, (rowOffsets[bottomIndex] - verticalOffset).toFloat())
      } else {
        null
      }
    }
  }

  fun handleAt(
    x: Float,
    y: Float,
    radius: Float,
    centers: Pair<Pair<Float, Float>, Pair<Float, Float>>?
  ): Boolean? = centers?.let { (start, end) ->
    when {
      abs(x - start.first) <= radius && abs(y - start.second) <= radius -> true
      abs(x - end.first) <= radius && abs(y - end.second) <= radius -> false
      else -> null
    }
  }
}
