import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { logger } from '../lib/logger.js';
import { pool } from './pool.js';

/** Anything that can run a query: the pool or a client (inside or outside a transaction). */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

declare const txBrand: unique symbol;

/**
 * A client with an open transaction. Only `withTransaction` can produce one, so any
 * function that takes a `TxClient` is guaranteed to run inside a transaction.
 */
export type TxClient = Queryable & { readonly [txBrand]: true };

type CommitHook = () => Promise<void> | void;
const commitHooks = new WeakMap<object, CommitHook[]>();

/**
 * Registers work to run after the transaction COMMITs (never on rollback). Used for
 * best-effort side effects that must not happen inside a transaction, such as publishing
 * seat changes to Redis or invalidating a cache. Anything that MUST happen goes through
 * the outbox instead. Hook failures are logged and swallowed: the commit already happened.
 */
export function onCommit(tx: TxClient, hook: CommitHook): void {
  const hooks = commitHooks.get(tx);
  if (!hooks) throw new Error('onCommit: not a transaction created by withTransaction');
  hooks.push(hook);
}

async function runCommitHooks(hooks: CommitHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      logger.warn({ err }, 'after-commit hook failed');
    }
  }
}

export async function withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  let broken = false;
  const hooks: CommitHook[] = [];
  let result: T;
  try {
    await client.query('BEGIN');
    commitHooks.set(client, hooks);
    result = await fn(client as unknown as TxClient);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is in an unknown state; destroy it instead of returning it to the pool.
      broken = true;
    }
    throw err;
  } finally {
    commitHooks.delete(client);
    client.release(broken);
  }
  // Runs after the connection is back in the pool, so slow hooks never pin a connection.
  await runCommitHooks(hooks);
  return result;
}
