import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
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

export async function withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as TxClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is in an unknown state; destroy it instead of returning it to the pool.
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
