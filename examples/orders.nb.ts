// A notebook as a library: it cleans the orders table and exports the result. report.nb.ts imports it; importing runs
// only the cells the imported names need, never an action.
import { cell, action, exec, param } from 'smaltnb';
import { col, table } from '@smaltdb/df';

cell('params');
export const params = param({ minQty: param.number(1) });

cell('orders', { lang: 'df' });
export const orders = table('orders')
  .filter(col('qty').ge(params.minQty))
  .withColumns(col('qty').mul(col('price')).alias('revenue'));
orders;

action('archive');
await exec`DELETE FROM orders WHERE qty = 0`;
