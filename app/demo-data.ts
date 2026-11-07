// Tables the demo notebook reads, created once in a new database.
import type { Database } from 'smaltdb';

export async function seedDemo(db: Database): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, region TEXT, qty INTEGER, price REAL);
    CREATE TABLE IF NOT EXISTS region_totals(region TEXT, revenue REAL)`);
  const r = await db.query('SELECT count(*) AS n FROM orders', [], { rowMode: 'array' });
  if (Number(r[0]?.[0] ?? 0) > 0) return;
  const regions = ['north', 'east', 'south', 'west'];
  const values: string[] = [];
  for (let i = 1; i <= 2000; i++) {
    const qty = (i * 7) % 6;
    const price = Math.round(((i * 37) % 4000) / 10 + 5) / 1;
    values.push(`(${i}, '${regions[(i * 3) % 4]}', ${qty}, ${price})`);
  }
  await db.exec(`INSERT INTO orders VALUES ${values.join(', ')}`);
}
