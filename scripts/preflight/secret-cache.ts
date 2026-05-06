import { mask } from "./redactor";

export class SecretCache {
  private readonly hashes = new Map<string, string>();

  static empty(): SecretCache {
    return new SecretCache();
  }

  has(key: string): boolean {
    return this.hashes.has(key);
  }

  hashOf(key: string): string | undefined {
    return this.hashes.get(key);
  }

  setPlaceholderForTest(key: string, value: string): void {
    this.hashes.set(key, mask(value));
  }
}
