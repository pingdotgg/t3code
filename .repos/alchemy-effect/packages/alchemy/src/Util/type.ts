export type type<T> = new () => T;
export const type = class {} as new <T>() => T;

export declare namespace type {
  export type of<T extends type<any>> = InstanceType<T>;
}
