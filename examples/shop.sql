-- Tables for examples/shop.nb.ts in a headless run: smaltnb run examples/shop.nb.ts --init examples/shop.sql
CREATE TABLE orders(id INTEGER PRIMARY KEY, region TEXT, qty INTEGER, price REAL);
CREATE TABLE region_totals(region TEXT, revenue REAL);
INSERT INTO orders VALUES
  (1, 'north', 3, 18.5), (2, 'east', 0, 42), (3, 'south', 1, 7.25), (4, 'north', 2, 12),
  (5, 'west', 5, 240), (6, 'east', 4, 310), (7, 'south', 2, 95.5), (8, 'west', 1, 1200);
