// A graph from a table: the orders become (:Region)-[:PLACED]->(:Order) in the notebook's graph (smaltcy, in memory),
// queried with Cypher and read back with SQL. Run it with
// `smaltnb run examples/network.nb.ts --init examples/shop.sql --actions`.
import { action, cell, cypher, md, sql } from 'smaltnb';

cell('intro', { lang: 'md' });
md`# Orders as a graph

**Build the graph** loads the orders into the notebook's graph. Then the Cypher cells query it, and SQL reads their
results back.`;

cell('orders', { lang: 'sql' });
export const orders = sql<{ id: number; region: string; qty: number; price: number }>`
  SELECT id, region, qty, price FROM orders WHERE qty > 0`;

action('Build the graph', { lang: 'cypher' });
await cypher.run`MATCH (n) DETACH DELETE n`;
await cypher.run`UNWIND ${orders} AS o
  MERGE (r:Region {name: o.region})
  CREATE (r)-[:PLACED]->(:Order {id: o.id, qty: o.qty, revenue: o.qty * o.price})`;

cell('placed', { lang: 'cypher' });
export const placed = cypher`MATCH (r:Region)-[p:PLACED]->(o:Order) RETURN r, p, o`;
placed;

cell('byRegion', { lang: 'cypher' });
export const byRegion = cypher`MATCH (r:Region)-[:PLACED]->(o:Order)
RETURN r.name AS region, count(o) AS orders, sum(o.revenue) AS revenue
ORDER BY revenue DESC`;
byRegion;

cell('top', { lang: 'sql' });
export const top = sql`SELECT region, revenue FROM ${byRegion} WHERE revenue > 500`;
top;
