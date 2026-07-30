import type * as Arr from "../Array.ts"
import type * as Channel from "../Channel.ts"
import { identity } from "../Function.ts"
import { pipeArguments } from "../Pipeable.ts"
import type { Stream } from "../Stream.ts"

const TypeId = "~effect/Stream"

const streamVariance = {
  _R: identity,
  _E: identity,
  _A: identity
}

const StreamProto = {
  [TypeId]: streamVariance,
  pipe() {
    return pipeArguments(this, arguments)
  }
}
/** @internal */
export const fromChannel = <A extends Arr.NonEmptyReadonlyArray<any>, E, R>(
  channel: Channel.Channel<A, E, void, unknown, unknown, unknown, R>
): Stream<A extends Arr.NonEmptyReadonlyArray<infer A> ? A : never, E, R> => {
  const self = Object.create(StreamProto)
  self.channel = channel
  return self
}
