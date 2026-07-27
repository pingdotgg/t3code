export type Named<Id extends string> = {
  readonly "~alchemy/Id": Id;
};
export type Tag<K extends string = string> = {
  readonly "~alchemy/Tag": K;
};
