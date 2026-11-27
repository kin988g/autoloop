import type { Receipt } from "./types.ts";

// A fence closes only on a line of its own. A JSON string cannot hold a raw
// newline, so a ``` inside one is never the end of the block.
const BLOCK =
  /(?<=^|\n)[ \t]*```agent-autoloop[ \t]*\r?\n((?:[^\n]*\n)*?)[ \t]*```[ \t]*(?=\r?\n|$)/g;
const OPENED = /(?<=^|\n)[ \t]*```agent-autoloop[ \t]*\r?\n/;

export interface ReceiptExtract {
  receipt?: Receipt;
  error?: string;
  raw?: string;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findBlocks(text: string): Array<{ raw: string; body: string }> {
  const normalized = normalizeNewlines(text);
  const blocks: Array<{ raw: string; body: string }> = [];
  const pattern = new RegExp(BLOCK.source, "g");
  for (const match of normalized.matchAll(pattern)) {
    blocks.push({ raw: match[1] ?? "", body: match[1] ?? "" });
  }
  return blocks;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string | { error: string } {
  if (typeof value !== "string") return { error: `${field} must be a string` };
  return value;
}

export function validateReceipt(value: unknown): { receipt?: Receipt; error?: string } {
  if (!isPlainObject(value)) return { error: "Receipt must be a JSON object" };

  const receipt: Receipt = {};

  if (value.ask !== undefined) {
    if (!isPlainObject(value.ask)) return { error: "ask must be an object" };
    const title = asString(value.ask.title, "ask.title");
    if (typeof title !== "string") return title;
    const body = asString(value.ask.body, "ask.body");
    if (typeof body !== "string") return body;
    const ask: NonNullable<Receipt["ask"]> = { title, body };
    if (value.ask.options !== undefined) {
      if (
        !Array.isArray(value.ask.options) ||
        value.ask.options.some((option) => typeof option !== "string")
      ) {
        return { error: "ask.options must be an array of strings" };
      }
      ask.options = value.ask.options;
    }
    receipt.ask = ask;
  }

  if (value.notice !== undefined) {
    if (!isPlainObject(value.notice)) return { error: "notice must be an object" };
    const title = asString(value.notice.title, "notice.title");
    if (typeof title !== "string") return title;
    const body = asString(value.notice.body, "notice.body");
    if (typeof body !== "string") return body;
    receipt.notice = { title, body };
  }

  if (value.resolve !== undefined) {
    if (!isPlainObject(value.resolve)) return { error: "resolve must be an object" };
    const cardId = asString(value.resolve.cardId, "resolve.cardId");
    if (typeof cardId !== "string") return cardId;
    const resolve: NonNullable<Receipt["resolve"]> = { cardId };
    if (value.resolve.summary !== undefined) {
      const summary = asString(value.resolve.summary, "resolve.summary");
      if (typeof summary !== "string") return summary;
      resolve.summary = summary;
    }
    receipt.resolve = resolve;
  }

  if (value.later !== undefined) {
    if (!isPlainObject(value.later)) return { error: "later must be an object" };
    if (typeof value.later.delaySeconds !== "number" || !Number.isFinite(value.later.delaySeconds)) {
      return { error: "later.delaySeconds must be a finite number" };
    }
    const reason = asString(value.later.reason, "later.reason");
    if (typeof reason !== "string") return reason;
    receipt.later = { delaySeconds: value.later.delaySeconds, reason };
  }

  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) return { error: "events must be an array" };
    const events: NonNullable<Receipt["events"]> = [];
    for (let index = 0; index < value.events.length; index++) {
      const item = value.events[index];
      if (!isPlainObject(item)) return { error: `events[${index}] must be an object` };
      const type = asString(item.type, `events[${index}].type`);
      if (typeof type !== "string") return type;
      if (!isPlainObject(item.payload)) {
        return { error: `events[${index}].payload must be an object` };
      }
      const event: NonNullable<Receipt["events"]>[number] = { type, payload: item.payload };
      if (item.lane !== undefined) {
        const lane = asString(item.lane, `events[${index}].lane`);
        if (typeof lane !== "string") return lane;
        event.lane = lane;
      }
      events.push(event);
    }
    receipt.events = events;
  }

  return { receipt };
}

/** Last schema-valid ```agent-autoloop block, if any. Malformed JSON is ignored. */
export function parseReceipt(text: string): Receipt | undefined {
  const blocks = findBlocks(text);
  for (let index = blocks.length - 1; index >= 0; index--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[index]!.body);
    } catch {
      continue;
    }
    const validated = validateReceipt(parsed);
    if (validated.receipt) return validated.receipt;
  }
  return undefined;
}

/**
 * Inspects the last fenced block (or an unclosed opening fence).
 * Use this to decide whether a same-session repair retry is needed.
 */
export function extractReceipt(text: string): ReceiptExtract {
  const normalized = normalizeNewlines(text);
  const blocks = findBlocks(normalized);
  if (blocks.length === 0) {
    if (OPENED.test(normalized)) {
      return {
        error: "Receipt code block is not closed: the closing ``` must be on its own line",
      };
    }
    return {};
  }
  const last = blocks[blocks.length - 1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.body);
  } catch (error) {
    return { error: `Invalid JSON: ${(error as Error).message}`, raw: last.raw };
  }
  const validated = validateReceipt(parsed);
  if (validated.error) return { error: validated.error, raw: last.raw };
  return { receipt: validated.receipt, raw: last.raw };
}
