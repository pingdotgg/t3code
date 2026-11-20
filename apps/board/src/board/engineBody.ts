import type { EngineRequest } from "../domain/forYou";
import type { answerApproval, ForYouTarget } from "../foryou/actions";

export interface EngineBodyProps {
  readonly target: ForYouTarget;
  readonly card: Parameters<typeof answerApproval>[1];
  readonly request: EngineRequest;
  /** The card is answered and waits on the engine. */
  readonly sent: boolean;
  readonly onError: (message: string | null) => void;
}
