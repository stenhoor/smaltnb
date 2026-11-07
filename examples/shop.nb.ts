// A notebook with SQL and dataframes on a smaltdb database: smaltdf reads a table, SQL summarises the collected
// frame, and an action saves the summary. It typechecks with tsc as written, and runs (see test/database.test.ts).
import { cell, action, sql, exec } from 'smaltnb';
import { col, table } from '@smaltdb/df';

cell('params');
export const minQty = 1;

cell('orders', { lang: 'df' });
export const orders = table('orders')
  .filter(col('qty').ge(minQty))
  .withColumns(col('qty').mul(col('price')).alias('revenue'));

cell('byRegion', { lang: 'sql' });
export const byRegion = sql<{ region: string; revenue: number }>`
  SELECT region, sum(revenue) AS revenue FROM ${orders} GROUP BY region ORDER BY revenue DESC`;
byRegion;

action('save totals');
await exec`DELETE FROM region_totals`;
await exec`INSERT INTO region_totals SELECT region, revenue FROM ${byRegion}`;
