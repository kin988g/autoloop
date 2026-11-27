#!/usr/bin/env node
/**
 * AutoLoop Studio — AI 热点新闻采集与网页生成
 * Zero external runtime dependencies, Node >= 24 ESM, Linux + Windows.
 *
 *   collect  并发抓取公开数据源，写入 data/ai-news-latest.json
 *   render   生成离线交互式网页 apps/web/dist/ai-news.html，并发出确认卡片
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PAGE_URL = "http://127.0.0.1:3350/ai-news.html";
const DATA_REL = "data/ai-news-latest.json";
const FETCH_MS = 10_000;
const USER_AGENT = "autoloop-studio";
const SOURCE_HN = "Hacker News";
const SOURCE_HF = "Hugging Face";
const SOURCE_GH = "GitHub";
const SOURCE_TC = "TechCrunch";

const command = process.argv[2];
const contextPath = process.env.AUTOLOOP_CONTEXT_PATH;

if (!contextPath) {
  console.error("AUTOLOOP_CONTEXT_PATH is required");
  process.exit(1);
}

if (command !== "collect" && command !== "render") {
  console.error('Usage: node scripts/ai-news-pipeline.mjs <collect|render>');
  process.exit(1);
}

const ctx = JSON.parse(readFileSync(contextPath, "utf8"));
const sessionId =
  process.env.AUTOLOOP_SESSION_ID || `ai-news-${command}-${Date.now()}`;
const cwd = process.cwd();
const dataPath = join(cwd, "data", "ai-news-latest.json");
const htmlPath = join(cwd, "apps", "web", "dist", "ai-news.html");

function emit(receipt) {
  const finalText = `\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``;
  process.stdout.write(`${JSON.stringify({ finalText, sessionId })}\n`);
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function truncate(text, max = 240) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

function decodeEntities(input) {
  return String(input ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripHtml(input) {
  return decodeEntities(String(input ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeUrl(url) {
  const safe = safeHttpUrl(url);
  if (!safe) return String(url ?? "").trim().toLowerCase();
  const parsed = new URL(safe);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|ref$|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  let href = parsed.toString();
  if (href.endsWith("/") && parsed.pathname !== "/") href = href.slice(0, -1);
  return href;
}

function shortId(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function toIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function hoursAgo(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return (Date.now() - date.getTime()) / 3_600_000;
}

function heatLabel(score) {
  if (score >= 850) return "爆热";
  if (score >= 650) return "很热";
  if (score >= 400) return "热门";
  return "关注";
}

function item({ id, title, url, source, heatScore, publishedAt, summary }) {
  const safeUrl = safeHttpUrl(url);
  const cleanTitle = stripHtml(title).trim();
  if (!cleanTitle || !safeUrl) return null;
  const score = Math.max(0, Math.round(Number(heatScore) || 0));
  return {
    id,
    title: cleanTitle,
    url: safeUrl,
    source,
    heatScore: score,
    heatLabel: heatLabel(score),
    publishedAt: toIso(publishedAt) || new Date().toISOString(),
    summary: truncate(stripHtml(summary) || `${source} 真实公开条目`, 280),
  };
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_MS),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchJson(url, headers = {}) {
  const text = await fetchText(url, { Accept: "application/json", ...headers });
  return JSON.parse(text);
}

async function settle(name, fn) {
  try {
    const items = await fn();
    return { name, ok: true, items: items.filter(Boolean), error: null };
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const message = timeout
      ? "timeout 10s"
      : error instanceof Error
        ? error.message
        : String(error);
    return { name, ok: false, items: [], error: message };
  }
}

const AI_HINT =
  /\b(ai|a\.i\.|artificial intelligence|machine learning|deep learning|llm|llms|gpt|openai|anthropic|claude|deepseek|nvidia|chatgpt|gemini|grok|qwen|mistral|huggingface|hugging face|transformer|diffusion|agentic|neural|inference|foundation model|sora|copilot|gpu|token|model)\b/i;

async function collectHackerNews() {
  const since = Math.floor(Date.now() / 1000) - 14 * 86_400;
  const terms = ["AI", "LLM", "OpenAI", "Anthropic", "DeepSeek", "Claude", "Nvidia"];
  const numericFilters = `created_at_i>${since},points>20`;
  const results = await Promise.all(
    terms.map(async (term) => {
      const url =
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}` +
        `&tags=story&hitsPerPage=15&numericFilters=${encodeURIComponent(numericFilters)}`;
      try {
        const data = await fetchJson(url);
        return Array.isArray(data.hits) ? data.hits : [];
      } catch {
        return [];
      }
    }),
  );

  const byId = new Map();
  for (const hit of results.flat()) {
    if (!hit || !hit.objectID || byId.has(String(hit.objectID))) continue;
    const title = String(hit.title ?? "");
    const text = String(hit.story_text ?? "");
    if (!AI_HINT.test(`${title} ${text}`)) continue;
    const points = Number(hit.points) || 0;
    const comments = Number(hit.num_comments) || 0;
    const link = hit.url
      ? String(hit.url)
      : `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const summary = text
      ? stripHtml(text)
      : `Hacker News 热度 ${points} 分，${comments} 条讨论。`;
    byId.set(
      String(hit.objectID),
      item({
        id: `hn-${hit.objectID}`,
        title,
        url: link,
        source: SOURCE_HN,
        heatScore: points + comments * 0.2,
        publishedAt: hit.created_at,
        summary,
      }),
    );
  }
  return [...byId.values()];
}

async function collectHuggingFace() {
  const rows = await fetchJson("https://huggingface.co/api/daily_papers");
  if (!Array.isArray(rows)) throw new Error("unexpected Hugging Face payload");
  const mapped = rows
    .map((row) => {
      const paper = row?.paper && typeof row.paper === "object" ? row.paper : {};
      const id = String(paper.id ?? "").trim();
      const title = String(row.title || paper.title || "").trim();
      if (!id || !title) return null;
      const upvotes = Number(paper.upvotes ?? row.upvotes) || 0;
      const comments = Number(row.numComments) || 0;
      return item({
        id: `hf-${id}`,
        title,
        url: `https://huggingface.co/papers/${encodeURIComponent(id)}`,
        source: SOURCE_HF,
        heatScore: upvotes * 8 + comments * 6,
        publishedAt: row.publishedAt || paper.publishedAt || paper.submittedOnDailyAt,
        summary: paper.summary || row.summary || paper.ai_summary || "",
      });
    })
    .filter(Boolean);
  mapped.sort((a, b) => b.heatScore - a.heatScore);
  return mapped;
}

async function searchGitHubRepos(query) {
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
    `&sort=stars&order=desc&per_page=25`;
  const data = await fetchJson(url, {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  return Array.isArray(data.items) ? data.items : [];
}

async function collectGitHub() {
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  // GitHub's search parser rejects some parenthesized topic ORs (returns 200 + 0 hits).
  // Try a simple topic query first, then a keyword fallback.
  let repos = await searchGitHubRepos(`topic:llm stars:>200 pushed:>=${monthAgo}`);
  if (repos.length === 0) {
    repos = await searchGitHubRepos(
      `llm OR openai OR anthropic OR deepseek stars:>500 pushed:>=${monthAgo}`,
    );
  }
  if (repos.length === 0) throw new Error("GitHub Search returned no repositories");
  return repos
    .map((repo) => {
      const fullName = String(repo.full_name ?? "").trim();
      const htmlUrl = String(repo.html_url ?? "").trim();
      if (!fullName || !htmlUrl) return null;
      const stars = Number(repo.stargazers_count) || 0;
      const forks = Number(repo.forks_count) || 0;
      const pushedAt = repo.pushed_at || repo.updated_at;
      const recency = hoursAgo(pushedAt) <= 48 ? 30 : hoursAgo(pushedAt) <= 168 ? 12 : 0;
      const heat =
        Math.log10(Math.max(stars, 1)) * 70 +
        Math.log10(Math.max(forks, 1)) * 8 +
        recency;
      const description = String(repo.description ?? "").trim();
      const summary = `${description || "近期活跃的高星 AI 开源项目。"} ★ ${stars.toLocaleString("en-US")} · ${forks.toLocaleString("en-US")} forks`;
      return item({
        id: `gh-${fullName.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
        title: fullName,
        url: htmlUrl,
        source: SOURCE_GH,
        heatScore: heat,
        publishedAt: pushedAt,
        summary,
      });
    })
    .filter(Boolean);
}

async function collectTechCrunch() {
  const xml = await fetchText(
    "https://techcrunch.com/category/artificial-intelligence/feed/",
    { Accept: "application/rss+xml, application/xml, text/xml, */*" },
  );
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return blocks
    .map((block) => {
      const tag = (name) => {
        const match = block.match(
          new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
        );
        return match ? decodeEntities(match[1].trim()) : "";
      };
      const title = stripHtml(tag("title"));
      const url = tag("link") || tag("guid");
      const publishedAt = tag("pubDate");
      const summary = stripHtml(tag("description"));
      if (!title || !url) return null;
      const age = hoursAgo(toIso(publishedAt));
      const heat = Math.round(Math.max(50, 340 * Math.exp(-age / 40)));
      return item({
        id: `tc-${shortId(url)}`,
        title,
        url,
        source: SOURCE_TC,
        heatScore: heat,
        publishedAt,
        summary,
      });
    })
    .filter(Boolean);
}

function dedupeByUrl(items) {
  const seen = new Map();
  for (const entry of items) {
    if (!entry) continue;
    const key = normalizeUrl(entry.url);
    const existing = seen.get(key);
    if (!existing || entry.heatScore > existing.heatScore) seen.set(key, entry);
  }
  return [...seen.values()];
}

function byHeatThenTime(a, b) {
  if (b.heatScore !== a.heatScore) return b.heatScore - a.heatScore;
  return String(b.publishedAt).localeCompare(String(a.publishedAt));
}

// Keep the hottest items while making sure every successful source can appear
// in the 20–25 brief (raw HN points would otherwise crowd out everything else).
function selectTop(items, min = 20, max = 25) {
  const groups = new Map();
  for (const entry of items) {
    const list = groups.get(entry.source) ?? [];
    list.push(entry);
    groups.set(entry.source, list);
  }
  for (const list of groups.values()) list.sort(byHeatThenTime);

  const sourceCount = Math.max(groups.size, 1);
  const guaranteed = Math.min(7, Math.max(4, Math.floor(max / sourceCount)));
  const picked = [];
  const seen = new Set();

  const take = (entry) => {
    if (!entry || picked.length >= max) return;
    const urlKey = normalizeUrl(entry.url);
    if (seen.has(entry.id) || seen.has(urlKey)) return;
    picked.push(entry);
    seen.add(entry.id);
    seen.add(urlKey);
  };

  for (const list of groups.values()) {
    for (const entry of list.slice(0, guaranteed)) take(entry);
  }
  for (const entry of [...items].sort(byHeatThenTime)) {
    if (picked.length >= max) break;
    take(entry);
  }

  const selected = picked.sort(byHeatThenTime);
  if (selected.length > max) return rescaleWithinSource(selected.slice(0, max));
  if (selected.length > min) {
    const floor = selected[min - 1]?.heatScore ?? 0;
    let end = selected.length;
    for (let i = min; i < selected.length; i++) {
      if ((selected[i]?.heatScore ?? 0) < floor * 0.45) {
        end = i;
        break;
      }
    }
    return rescaleWithinSource(selected.slice(0, Math.max(min, end)));
  }
  return rescaleWithinSource(selected);
}

function rescaleWithinSource(items) {
  const groups = new Map();
  for (const entry of items) {
    const list = groups.get(entry.source) ?? [];
    list.push(entry);
    groups.set(entry.source, list);
  }
  const out = [];
  for (const list of groups.values()) {
    const ranked = [...list].sort(byHeatThenTime);
    const scores = ranked.map((entry) => entry.heatScore);
    const unique = new Set(scores).size;
    const max = Math.max(...scores, 1);
    const min = Math.min(...scores);
    ranked.forEach((entry, index) => {
      let t;
      if (ranked.length === 1) t = 1;
      else if (unique === 1) t = 1 - index / (ranked.length - 1);
      else t = (entry.heatScore - min) / (max - min);
      const heatScore = Math.round(280 + Math.pow(t, 0.75) * 700);
      out.push({ ...entry, heatScore, heatLabel: heatLabel(heatScore) });
    });
  }
  return out.sort(byHeatThenTime);
}

function countBySource(items) {
  const counts = {
    [SOURCE_HN]: 0,
    [SOURCE_HF]: 0,
    [SOURCE_GH]: 0,
    [SOURCE_TC]: 0,
  };
  for (const entry of items) {
    if (entry.source in counts) counts[entry.source] += 1;
    else counts[entry.source] = (counts[entry.source] ?? 0) + 1;
  }
  return counts;
}

function formatSourceLine(counts, results) {
  return [SOURCE_HN, SOURCE_HF, SOURCE_GH, SOURCE_TC]
    .map((name) => {
      const found = results.find((row) => row.name === name);
      if (found && !found.ok) return `${name} 失败（${found.error}）`;
      return `${name} ${counts[name] ?? 0} 条`;
    })
    .join("、");
}

function buildHtml(payload) {
  const dataJson = JSON.stringify({
    generatedAt: payload.generatedAt,
    count: payload.count,
    sources: payload.sources,
    items: payload.items,
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const generatedLabel = escapeHtml(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(payload.generatedAt)) + "（Asia/Shanghai）",
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>今日 AI 热点 · AutoLoop Studio</title>
  <style>
    :root {
      --bg0: #090b11;
      --bg1: #10141f;
      --card: rgba(20, 24, 36, 0.84);
      --card-hover: rgba(28, 34, 52, 0.94);
      --line: rgba(255, 255, 255, 0.08);
      --text: #f3f5fb;
      --muted: #9aa3b7;
      --faint: #6d7588;
      --accent: #7c5cff;
      --accent-2: #3ee0c5;
      --hn: #ff7a3d;
      --hf: #ffd45c;
      --gh: #7ee787;
      --tc: #5eead4;
      --hot-1: #ff5c7a;
      --hot-2: #ff9a3d;
      --hot-3: #f5d061;
      --hot-4: #6ee7b7;
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
      --sans: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
      --mono: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--sans);
      color: var(--text);
      background:
        radial-gradient(1200px 500px at 10% -10%, rgba(124, 92, 255, 0.22), transparent 55%),
        radial-gradient(900px 420px at 100% 0%, rgba(62, 224, 197, 0.12), transparent 50%),
        linear-gradient(180deg, var(--bg1), var(--bg0) 30%);
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: radial-gradient(rgba(255,255,255,0.045) 0.8px, transparent 0.8px);
      background-size: 22px 22px;
      mask-image: linear-gradient(180deg, rgba(0,0,0,0.7), transparent 85%);
    }
    .wrap {
      position: relative;
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 36px 0 72px;
    }
    header.hero {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 20px 32px;
      align-items: flex-end;
      margin-bottom: 28px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent-2);
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 650;
      margin-bottom: 10px;
    }
    .eyebrow span.dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent-2);
      box-shadow: 0 0 0 4px rgba(62, 224, 197, 0.16);
    }
    h1 {
      margin: 0;
      font-size: clamp(32px, 5vw, 52px);
      letter-spacing: -0.04em;
      line-height: 1.05;
    }
    .sub {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 15px;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .stat {
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .stat b { color: var(--text); font-weight: 650; padding-right: 4px; }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      padding: 12px 0 16px;
      background: linear-gradient(180deg, rgba(9,11,17,0.92), rgba(9,11,17,0.78) 70%, transparent);
      backdrop-filter: blur(10px);
    }
    .search {
      flex: 1 1 260px;
      position: relative;
    }
    .search input {
      width: 100%;
      border: 1px solid var(--line);
      background: #161b28;
      color: var(--text);
      border-radius: 12px;
      padding: 12px 14px 12px 40px;
      font: inherit;
      outline: none;
    }
    .search input::placeholder { color: var(--faint); }
    .search input:focus {
      border-color: rgba(124, 92, 255, 0.7);
      box-shadow: 0 0 0 3px rgba(124, 92, 255, 0.2);
    }
    .search svg {
      position: absolute;
      left: 13px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0.55;
    }
    .filters, .sorts { display: flex; flex-wrap: wrap; gap: 8px; }
    button.chip, button.sort {
      border: 1px solid var(--line);
      background: #141824;
      color: var(--muted);
      border-radius: 999px;
      padding: 8px 12px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    button.chip[aria-pressed="true"] {
      color: var(--text);
      border-color: transparent;
      background: color-mix(in srgb, var(--tone, var(--accent)) 18%, #141824);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone, var(--accent)) 55%, transparent);
    }
    button.sort[aria-pressed="true"] {
      color: var(--text);
      background: #22184a;
      border-color: rgba(124, 92, 255, 0.55);
    }
    .meta-count {
      margin-left: auto;
      color: var(--faint);
      font-size: 13px;
    }
    .list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }
    @media (min-width: 860px) {
      .list { grid-template-columns: 1fr 1fr; }
      .card.wide { grid-column: 1 / -1; }
    }
    a.card {
      display: flex;
      gap: 16px;
      align-items: stretch;
      text-decoration: none;
      color: inherit;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px 16px 16px 0;
      box-shadow: var(--shadow);
      transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
    }
    a.card:hover, a.card:focus-visible {
      transform: translateY(-2px);
      background: var(--card-hover);
      border-color: color-mix(in srgb, var(--tone) 45%, var(--line));
      outline: none;
    }
    .rail {
      width: 6px;
      border-radius: 18px 0 0 18px;
      background: var(--tone);
      flex: 0 0 6px;
    }
    .body { min-width: 0; flex: 1; }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 8px;
    }
    .src {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--tone);
      font-weight: 650;
      letter-spacing: 0.02em;
    }
    .src i {
      width: 7px; height: 7px; border-radius: 50%; background: var(--tone); font-style: normal;
    }
    .when { color: var(--faint); font-size: 12px; white-space: nowrap; }
    h2 {
      margin: 0 0 8px;
      font-size: 18px;
      letter-spacing: -0.02em;
      line-height: 1.35;
    }
    p.summary {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    .heat {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      justify-content: flex-start;
      gap: 6px;
      min-width: 64px;
      padding-top: 2px;
    }
    .heat b {
      font-family: var(--mono);
      font-size: 18px;
      letter-spacing: -0.04em;
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      border-radius: 999px;
      padding: 3px 8px;
      background: color-mix(in srgb, var(--heat) 16%, transparent);
      color: var(--heat);
    }
    .empty {
      grid-column: 1 / -1;
      text-align: center;
      color: var(--muted);
      padding: 56px 16px;
      border: 1px dashed var(--line);
      border-radius: 18px;
    }
    footer {
      margin-top: 36px;
      color: var(--faint);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .tone-hn { --tone: var(--hn); }
    .tone-hf { --tone: var(--hf); }
    .tone-gh { --tone: var(--gh); }
    .tone-tc { --tone: var(--tc); }
    .heat-爆热 { --heat: var(--hot-1); }
    .heat-很热 { --heat: var(--hot-2); }
    .heat-热门 { --heat: var(--hot-3); }
    .heat-关注 { --heat: var(--hot-4); }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div>
        <div class="eyebrow"><span class="dot"></span>AutoLoop Studio Daily Brief</div>
        <h1>今日 AI 热点</h1>
        <p class="sub">采集于 ${generatedLabel} · 全部来自公开真实数据源，未编造条目</p>
      </div>
      <div class="stats" id="stats"></div>
    </header>
    <div class="toolbar">
      <label class="search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/>
          <path d="M16 16l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <input id="q" type="search" placeholder="搜索标题、摘要或来源…" autocomplete="off">
      </label>
      <div class="filters" id="filters"></div>
      <div class="sorts">
        <button type="button" class="sort" data-sort="heat" aria-pressed="true">按热度</button>
        <button type="button" class="sort" data-sort="time" aria-pressed="false">按时间</button>
      </div>
      <div class="meta-count" id="shown"></div>
    </div>
    <section class="list" id="list"></section>
    <footer>
      <div>由 AutoLoop Studio 自动采集生成 · 完全离线可浏览，不依赖外部 CDN</div>
      <div>数据源：Hacker News、Hugging Face Daily Papers、GitHub、TechCrunch AI</div>
    </footer>
  </div>
  <script type="application/json" id="news-data">${dataJson}</script>
  <script>
    const payload = JSON.parse(document.getElementById("news-data").textContent);
    const items = Array.isArray(payload.items) ? payload.items : [];
    const sourceNames = ["Hacker News", "Hugging Face", "GitHub", "TechCrunch"];
    const toneMap = {
      "Hacker News": "tone-hn",
      "Hugging Face": "tone-hf",
      "GitHub": "tone-gh",
      "TechCrunch": "tone-tc"
    };
    const active = new Set(sourceNames);
    let sortKey = "heat";

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    const safeUrl = (url) => {
      try {
        const parsed = new URL(String(url));
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "#";
      } catch { return "#"; }
    };

    function formatTime(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      const diff = Date.now() - date.getTime();
      const hours = Math.round(diff / 3600000);
      const rel = hours < 1 ? "刚刚" : hours < 24 ? hours + " 小时前" : Math.round(hours / 24) + " 天前";
      const abs = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
      return rel + " · " + abs;
    }

    const stats = $("stats");
    const total = document.createElement("div");
    total.className = "stat";
    total.innerHTML = "<b>" + escapeHtml(String(payload.count ?? items.length)) + "</b>条精选";
    stats.appendChild(total);
    for (const name of sourceNames) {
      const node = document.createElement("div");
      node.className = "stat";
      node.innerHTML = "<b>" + escapeHtml(String((payload.sources && payload.sources[name]) || 0)) + "</b>" + escapeHtml(name);
      stats.appendChild(node);
    }

    const filters = $("filters");
    for (const name of sourceNames) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip " + (toneMap[name] || "");
      btn.setAttribute("aria-pressed", "true");
      btn.dataset.source = name;
      btn.textContent = name;
      btn.addEventListener("click", () => {
        if (active.has(name) && active.size === 1) {
          for (const item of sourceNames) active.add(item);
        } else if (active.has(name)) {
          active.delete(name);
        } else {
          active.add(name);
        }
        render();
      });
      filters.appendChild(btn);
    }

    for (const btn of document.querySelectorAll("button.sort")) {
      btn.addEventListener("click", () => {
        sortKey = btn.dataset.sort;
        render();
      });
    }

    $("q").addEventListener("input", render);

    function render() {
      const query = $("q").value.trim().toLowerCase();
      for (const btn of filters.querySelectorAll("button.chip")) {
        btn.setAttribute("aria-pressed", active.has(btn.dataset.source) ? "true" : "false");
      }
      for (const btn of document.querySelectorAll("button.sort")) {
        btn.setAttribute("aria-pressed", btn.dataset.sort === sortKey ? "true" : "false");
      }
      const next = items.filter((entry) => {
        if (!active.has(entry.source)) return false;
        if (!query) return true;
        const blob = (entry.title + " " + entry.summary + " " + entry.source).toLowerCase();
        return blob.includes(query);
      }).sort((a, b) => {
        if (sortKey === "time") return String(b.publishedAt).localeCompare(String(a.publishedAt));
        if (b.heatScore !== a.heatScore) return b.heatScore - a.heatScore;
        return String(b.publishedAt).localeCompare(String(a.publishedAt));
      });

      $("shown").textContent = "显示 " + next.length + " / " + items.length;
      const list = $("list");
      list.replaceChildren();
      if (next.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "没有符合当前筛选条件的新闻。";
        list.appendChild(empty);
        return;
      }
      next.forEach((entry, index) => {
        const card = document.createElement("a");
        card.className = "card " + (toneMap[entry.source] || "") + (index === 0 && sortKey === "heat" ? " wide" : "");
        card.href = safeUrl(entry.url);
        card.target = "_blank";
        card.rel = "noopener noreferrer";
        card.innerHTML =
          '<div class="rail"></div>' +
          '<div class="body">' +
            '<div class="top">' +
              '<span class="src"><i></i>' + escapeHtml(entry.source) + "</span>" +
              '<span class="when">' + escapeHtml(formatTime(entry.publishedAt)) + "</span>" +
            "</div>" +
            "<h2>" + escapeHtml(entry.title) + "</h2>" +
            '<p class="summary">' + escapeHtml(entry.summary) + "</p>" +
          "</div>" +
          '<div class="heat heat-' + escapeHtml(entry.heatLabel) + '">' +
            "<b>" + escapeHtml(String(entry.heatScore)) + "</b>" +
            '<span class="badge">' + escapeHtml(entry.heatLabel) + "</span>" +
          "</div>";
        list.appendChild(card);
      });
    }

    render();
  </script>
</body>
</html>
`;
}

async function runCollect() {
  const results = await Promise.all([
    settle(SOURCE_HN, collectHackerNews),
    settle(SOURCE_HF, collectHuggingFace),
    settle(SOURCE_GH, collectGitHub),
    settle(SOURCE_TC, collectTechCrunch),
  ]);

  const merged = dedupeByUrl(results.flatMap((row) => row.items));
  const collected = Object.fromEntries(results.map((row) => [row.name, row.items.length]));
  const items = selectTop(merged, 20, 25);
  const sources = countBySource(items);
  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    count: items.length,
    sources,
    collected,
    items,
    sourceErrors: Object.fromEntries(
      results.filter((row) => !row.ok).map((row) => [row.name, row.error]),
    ),
  };

  ensureDir(dataPath);
  writeFileSync(dataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const topTitles = items.slice(0, 5).map((entry) => entry.title);
  const failed = results.filter((row) => !row.ok);
  const failNote = failed.length
    ? `\n有 ${failed.length} 个数据源未能成功（已优雅降级，未编造条目）：${failed.map((row) => `${row.name}（${row.error}）`).join("、")}。`
    : "";
  const topBlock = topTitles.map((title, index) => `${index + 1}. ${title}`).join("\n");
  const collectedLine = [SOURCE_HN, SOURCE_HF, SOURCE_GH, SOURCE_TC]
    .map((name) => `${name} 抓取 ${collected[name] ?? 0} 条`)
    .join("、");
  const body =
    items.length === 0
      ? `本次未能从公开数据源抓取到可用的真实 AI 新闻。${failNote}`
      : `已从公开数据源抓取到 ${merged.length} 条去重后的真实条目（${collectedLine}），并保留热度最高的 ${items.length} 条精选（${formatSourceLine(sources, results)}）。\n数据已写入 ${DATA_REL}。\n\n热度最高的 5 条：\n${topBlock}${failNote}`;

  emit({
    notice: {
      title:
        items.length === 0
          ? "AI 热点新闻采集未取得有效条目"
          : `AI 热点新闻已采集（共 ${items.length} 条）`,
      body,
    },
    events: [
      {
        type: "ai-news.collected",
        lane: "ai-news-daily",
        payload: {
          count: items.length,
          generatedAt,
          sources,
          topTitles,
          dataPath: DATA_REL,
        },
      },
    ],
  });
}

function readNewsFile() {
  const raw = readFileSync(dataPath, "utf8");
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return { ...parsed, items, count: items.length };
}

async function runRender() {
  if (ctx.answer) {
    const choice = String(ctx.answer.choice ?? "").trim();
    const text = String(ctx.answer.text ?? "").trim();
    const confirmed = choice.includes("确认没问题") || choice === "确认";
    const note = text ? `\n备注：${text}` : "";
    if (confirmed) {
      emit({
        notice: {
          title: "AI 热点新闻网页已确认通过",
          body: `你已确认网页展示没问题。可随时打开 ${PAGE_URL} 查阅完整交互式页面。${note}`,
        },
      });
      return;
    }
    emit({
      notice: {
        title: "已收到调整意见，等待你补充具体需求",
        body:
          `你选择了「${choice || "需要调整展示或补充来源"}」。${note}\n` +
          `请告诉我希望调整的展示方式或需要补充的数据源，我会继续修改后再请你确认。当前页面仍可预览：${PAGE_URL}`,
      },
    });
    return;
  }

  let news;
  try {
    news = readNewsFile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      notice: {
        title: "无法生成 AI 热点新闻网页",
        body: `未找到有效的采集结果（${DATA_REL}）：${message}。请先重新运行采集步骤。`,
      },
    });
    return;
  }

  ensureDir(htmlPath);
  writeFileSync(htmlPath, buildHtml(news), "utf8");

  const topBlock = news.items
    .slice(0, 5)
    .map((entry, index) => `${index + 1}. ${entry.title}（${entry.source} · ${entry.heatLabel}）`)
    .join("\n");
  const sourceBits = Object.entries(news.sources ?? countBySource(news.items))
    .map(([name, count]) => `${name} ${count} 条`)
    .join("、");

  emit({
    ask: {
      title: `AI 热点新闻网页已生成（共 ${news.count} 条），请确认`,
      body:
        `已生成可离线浏览的交互式网页：${PAGE_URL}\n` +
        `支持搜索、来源筛选，以及按热度或时间排序。来源分布：${sourceBits || "无"}。\n\n` +
        `当前热度最高的 5 条：\n${topBlock || "（暂无条目）"}\n\n` +
        `请确认展示是否满意，或告诉我需要调整的地方。`,
      options: ["确认没问题", "需要调整展示或补充来源"],
    },
  });
}

async function main() {
  if (command === "collect") await runCollect();
  else await runRender();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
