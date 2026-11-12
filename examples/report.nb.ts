// A notebook that imports another: orders.nb.ts cleans the orders, and this one summarises them. Run it with
// `smaltnb run examples/report.nb.ts --init examples/shop.sql`.
import { cell, sql } from 'smaltnb';
import { orders } from './orders.nb.ts';

cell('byRegion', { lang: 'sql' });
export const byRegion = sql<{ region: string; revenue: number }>`
  SELECT region, sum(revenue) AS revenue FROM ${orders} GROUP BY region ORDER BY revenue DESC`;
byRegion;
