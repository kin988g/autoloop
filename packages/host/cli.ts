import { startStudio } from "./studio.ts";

function usage(): never {
  console.error("usage: node packages/host/cli.ts up [--host <host>] [--port <port>] [--data-dir <dir>]");
  process.exit(1);
}

function parseArgs(argv: string[]): { cmd: string; host?: string; port?: number; dataDir?: string } {
  const cmd = argv[0] ?? "";
  const rest = argv.slice(1);
  const out: { cmd: string; host?: string; port?: number; dataDir?: string } = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) usage();
      i += 1;
      return value;
    };
    if (arg === "--host") out.host = next();
    else if (arg.startsWith("--host=")) out.host = arg.slice("--host=".length);
    else if (arg === "--port") out.port = Number(next());
    else if (arg.startsWith("--port=")) out.port = Number(arg.slice("--port=".length));
    else if (arg === "--data-dir") out.dataDir = next();
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
    else usage();
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0)) usage();
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== "up") usage();
  const studio = await startStudio({
    host: args.host,
    port: args.port,
    dataDir: args.dataDir,
  });
  console.log(`hub listening on ${studio.url}`);
  console.log(`web console ${studio.url}/`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await studio.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
