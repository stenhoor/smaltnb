// A notebook with SQL and dataframes on a smaltdb database: smaltdf reads a table, SQL summarises the collected
// frame, a chart draws it, controls pick the big orders, and an action saves the summary. It typechecks with tsc as
// written, and runs (see test/database.test.ts).
import { cell, action, sql, exec, param, md, ui, chart } from 'smaltnb';
import { col, table } from '@smaltdb/df';

cell('intro', { lang: 'md' });
md`# Shop analysis
Revenue by region from the **orders** table. Change *minQty* in the parameters bar: the cells that read it run again.`;

cell('params');
export const params = param({ minQty: param.number(1) });

cell('orders', { lang: 'df' });
export const orders = table('orders')
  .filter(col('qty').ge(params.minQty))
  .withColumns(col('qty').mul(col('price')).alias('revenue'));

cell('byRegion', { lang: 'sql' });
export const byRegion = sql<{ region: string; revenue: number }>`
  SELECT region, sum(revenue) AS revenue FROM ${orders} GROUP BY region ORDER BY revenue DESC`;
byRegion;

cell('revenueChart');
chart.bar(byRegion, { x: 'region', y: 'revenue', labels: true });

cell('bigOrders');
const region = ui.select(['all', 'north', 'east', 'south', 'west'], 'all', { label: 'Region' });
const atLeast = ui.slider(0, 2000, 1000, { step: 100, label: 'Revenue at least' });
export const bigOrders = sql`SELECT id, region, qty, price, revenue FROM ${orders}
  WHERE revenue >= ${atLeast.value} AND ${region.value} IN ('all', region) ORDER BY revenue DESC, id`;
bigOrders;

action('save totals', { lang: 'sql' });
await exec`DELETE FROM region_totals`;
await exec`INSERT INTO region_totals SELECT region, revenue FROM ${byRegion}`;
