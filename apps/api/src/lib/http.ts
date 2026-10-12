/**
 * A fully-formed HTTP outcome produced by a service. Used by idempotent endpoints,
 * where the exact response (including some 4xx) must be stored and replayed.
 */
export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  replayed: boolean;
}
