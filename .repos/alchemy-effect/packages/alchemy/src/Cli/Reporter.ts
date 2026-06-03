import * as Context from "effect/Context";

export class Reporter extends Context.Service<
  Reporter,
  {
    report: (event: Event) => void;
  }
>()("Reporter") {}
