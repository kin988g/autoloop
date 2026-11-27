import { main } from "./run.ts";

// Thin alias. The primary standalone entry point is `node packages/worker/run.ts`.
await main(process.argv.slice(2));
