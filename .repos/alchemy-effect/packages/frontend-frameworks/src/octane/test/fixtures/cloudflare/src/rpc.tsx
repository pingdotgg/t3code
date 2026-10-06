module server {
  export async function greet(name: string) {
    return `hello ${name}`;
  }
}

import { greet } from "server";

export const requestGreeting = greet;
