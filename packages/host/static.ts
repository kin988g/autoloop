import { createReadStream, existsSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function defaultWebDist(): string | undefined {
  const candidate = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/healthz" || pathname === "/v1" || pathname.startsWith("/v1/");
}

function safeResolve(root: string, pathname: string): string | undefined {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const dest = resolve(root, `.${decoded}`);
  const base = resolve(root);
  if (dest !== base && !dest.startsWith(base + sep)) return undefined;
  return dest;
}

function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function statIfFile(path: string): Stats | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

function sendFile(res: ServerResponse, file: string, method: string, status = 200): boolean {
  const stat = statIfFile(file);
  if (!stat) return false;
  res.writeHead(status, {
    "Content-Type": mimeFor(file),
    "Content-Length": stat.size,
    "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file).on("error", () => {
    if (!res.writableEnded) res.destroy();
  }).pipe(res);
  return true;
}

/** Serve the built web console. Returns true if the response was handled. */
export function tryServeStatic(root: string, pathname: string, method: string, res: ServerResponse): boolean {
  const index = join(root, "index.html");
  if (!existsSync(index)) return false;
  if (pathname === "/" || pathname === "") {
    return sendFile(res, index, method);
  }
  const dest = safeResolve(root, pathname);
  if (!dest) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return true;
  }
  if (statIfFile(dest)) return sendFile(res, dest, method);
  try {
    const stat = statSync(dest);
    if (stat.isDirectory()) {
      const nested = join(dest, "index.html");
      if (statIfFile(nested)) return sendFile(res, nested, method);
    }
  } catch {
    // fall through to SPA fallback or 404
  }
  const ext = extname(pathname);
  if (ext && ext !== ".html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }
  return sendFile(res, index, method);
}
