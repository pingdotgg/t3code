import { uuidv4 } from "./uuid";

export interface TurnCommandMetadata {
  readonly commandId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: string;
}

export function makeTurnCommandMetadata(): TurnCommandMetadata {
  return {
    commandId: uuidv4(),
    messageId: uuidv4(),
    threadId: uuidv4(),
    createdAt: new Date().toISOString(),
  };
}

export function makeQueuedMessageMetadata(): Omit<TurnCommandMetadata, "threadId"> {
  return {
    commandId: uuidv4(),
    messageId: uuidv4(),
    createdAt: new Date().toISOString(),
  };
}
