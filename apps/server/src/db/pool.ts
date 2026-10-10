import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// bigint（int8）按字符串返回，由调用方转换为 BigInt 或 Number，避免精度丢失
pg.types.setTypeParser(20, (v) => v);

export function createPool(databaseUrl: string): Db {
  // 获取连接最多等 15 秒：异常情况下请求报错返回，而不是无限期挂起
  return new pg.Pool({ connectionString: databaseUrl, max: 20, connectionTimeoutMillis: 15_000 });
}

/** 在事务中执行；抛错自动回滚 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, isolation?: 'REPEATABLE READ'): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 忽略回滚失败，保留原始错误
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 只读一致快照 */
export function withSnapshot<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    return fn(tx);
  }, 'REPEATABLE READ');
}
