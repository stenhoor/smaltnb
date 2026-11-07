// A kernel in a Node worker thread, as a page runs one in a Web Worker.
import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import { serveKernel } from 'smaltnb/kernel';

serveKernel(
  { postMessage: (m) => parentPort.postMessage(m), addEventListener: (_type, listener) => parentPort.on('message', (data) => listener({ data })) },
  { ts },
);
