import ExpoModulesCore
import Foundation

struct TerminalBufferWriteRecord: Record {
  @Field var generation: Int = 0
  @Field var offset: Int = 0
  @Field var data: String = ""
}

/// UTF-16 offsets match JS and Android, including emoji and combining marks.
final class TerminalBufferStream {
  private(set) var generation = 0
  private var replay: [(text: String, length: Int)] = []
  private var retainedLength = 0
  private(set) var offset = 0
  var buffer: String { replay.map(\.text).joined() }

  struct Update {
    let reset: Bool
    let data: String
  }

  func apply(_ write: TerminalBufferWriteRecord) -> Update? {
    guard write.generation >= generation, write.offset >= 0 else { return nil }
    let reset = write.generation > generation
    guard !reset || write.offset == 0 else { return nil }
    guard reset || write.offset <= offset else { return nil }
    let data = write.data as NSString
    guard reset || data.length > offset - write.offset else { return nil }
    if reset {
      generation = write.generation
      replay.removeAll(keepingCapacity: true)
      retainedLength = 0
      offset = 0
    }
    let suffix = data.substring(from: offset - write.offset)
    offset += (suffix as NSString).length
    appendReplay(suffix)
    return Update(reset: reset, data: suffix)
  }

  private func appendReplay(_ data: String) {
    var start = data.startIndex
    while start < data.endIndex {
      let end = data.index(start, offsetBy: 16384, limitedBy: data.endIndex) ?? data.endIndex
      let chunk = String(data[start..<end])
      let length = (chunk as NSString).length
      if let last = replay.indices.last, replay[last].length + length <= 16384 {
        replay[last].text.append(chunk)
        replay[last].length += length
      } else {
        replay.append((text: chunk, length: length))
      }
      retainedLength += length
      start = end
    }
    while retainedLength > 512 * 1024 {
      retainedLength -= replay.removeFirst().length
    }
  }
}
