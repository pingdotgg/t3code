import * as Alchemy from "alchemy";

export class Backend extends Alchemy.Stack<
  Backend,
  {
    url: string;
  }
>()("Backend") {}
