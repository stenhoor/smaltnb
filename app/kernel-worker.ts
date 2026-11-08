// The kernel worker: runs cell code off the page (smaltnb/kernel). It reads and strips TypeScript with smaltty (from
// smaltkit/typescript, bundled in), opens the notebook's database in its own engine worker, and gives cells smaltdf.
import { open } from 'smaltdb';
import * as df from '@smaltdb/df';
import { smaltty } from 'smaltkit/typescript';
import { serveKernel, type MessageEndpoint } from '../src/kernel.js';
import { seedDemo } from './demo-data.js';

const here = (path: string) => new URL(path, self.location.href);
const engineWorker = () => new Worker(here('./db-worker.js'), { type: 'module', name: 'smaltdb' });

async function openDatabase() {
  try {
    const db = await open('smaltnb', { worker: engineWorker, multiTab: false });
    await seedDemo(db);
    return db;
  } catch (err) {
    // No OPFS here (a private window, an old browser): keep going in memory.
    console.warn('smaltnb: the database is in memory for this session:', err);
    const db = await open('smaltnb', { worker: engineWorker, storage: 'memory', multiTab: false });
    await seedDemo(db);
    return db;
  }
}

serveKernel(self as unknown as MessageEndpoint, {
  ts: smaltty,
  importModule: async (spec) => (spec === '@smaltdb/df' ? (df as unknown as Record<string, unknown>) : import(/* @vite-ignore */ spec)),
  database: openDatabase,
  frame: df.table,
});
