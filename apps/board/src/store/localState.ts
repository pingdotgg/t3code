import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LocalState = Schema.Struct({
  lastOpenedBoard: Schema.NullOr(
    Schema.Struct({ projectId: Schema.String, folder: Schema.String }),
  ),
  /** The ticket keys in the order the user dragged them to, by board id, then lane. */
  frameOrder: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});
export type LocalState = typeof LocalState.Type;

export const EMPTY_LOCAL_STATE: LocalState = { lastOpenedBoard: null, frameOrder: {} };

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LocalState));

/** The app's user data folder, which only the main process can reach. */
export interface LocalStateStorage {
  readonly read: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
}

/** State that belongs to this machine and stays out of the project: what the user last had open. */
export function createLocalState(storage: LocalStateStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<LocalState> =>
    Option.getOrElse(decode(await storage.read()), () => EMPTY_LOCAL_STATE);
  return {
    read,
    /** Reads, changes, and writes one update at a time, so two quick updates both land. */
    update: (change: (state: LocalState) => LocalState): Promise<LocalState> => {
      const next = queue.then(async () => {
        const state = change(await read());
        await storage.write(JSON.stringify(state));
        return state;
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
