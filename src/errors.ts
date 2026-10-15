export type ScopeErrorCode =
  | "bad-request"
  | "bad-rule"
  | "bad-resolvers"
  | "bad-ttl"
  | "not-found"
  | "expired"
  | "request-changed"
  | "no-grant"
  | "revoked"
  | "field-not-granted"
  | "private-field"
  | "unknown-field"
  | "resolver-failed"
  | "notice-failed"
  | "corrupt-store"
  | "store-busy";

/** Every refusal that foxscope throws. `code` is stable; the message is for people. */
export class ScopeError extends Error {
  readonly code: ScopeErrorCode;
  constructor(code: ScopeErrorCode, message: string) {
    super(message);
    this.name = "ScopeError";
    this.code = code;
  }
}
