// A notebook in plain TypeScript. SQL, dataframes and UI controls come with the runtime (milestone 1); this one only
// uses cell() and action(), and must typecheck with tsc as written.
import { cell, action } from 'smaltnb';

cell('types');
export interface Order {
  region: string;
  qty: number;
  price: number;
}

cell('params');
export const params = { mode: 'incremental' as 'incremental' | 'full', minQty: 1 };

cell('raw');
export const raw: Order[] = [
  { region: 'north', qty: 3, price: 18.5 },
  { region: 'east', qty: 0, price: 42 },
  { region: 'south', qty: 1, price: 7.25 },
  { region: 'north', qty: 2, price: 12 },
];

cell('clean', { run: 'lazy' });
export const clean = raw
  .filter((o) => o.qty >= params.minQty)
  .map((o) => ({ ...o, revenue: o.qty * o.price }));

cell('byRegion');
export const byRegion = Object.entries(
  clean.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.region]: (acc[o.region] ?? 0) + o.revenue }), {}),
).sort(([, a], [, b]) => b - a);
byRegion;

action('write clean', { when: () => params.mode === 'full' });
const written = clean.length;
console.log(`would write ${written} rows`);
