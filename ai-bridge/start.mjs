// Entry point of the bridge (npm start, and the login agent of
// scripts/autostart.mjs): checks the Node version before server.mjs is
// loaded, since its imports already need a Node that runs TypeScript.
import { requireNode } from './nodeVersion.mjs';

requireNode();
await import('./server.mjs');
