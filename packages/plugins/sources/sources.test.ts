import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, describe, it } from "node:test";
import {
  CronScheduler,
  createWebhookSource,
  genericSource,
  getSourceAdapter,
  githubSource,
  gitlabSource,
  matchesCron,
  nextCronTime,
  parseCron,
  sourceAdapters,
  webhookSource,
} from "./index.ts";
import type { CronRuleLike } from "./types.ts";

function sha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function shanghaiDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  return new Date(utcGuess);
}

describe("parseCron", () => {
  it("parses wildcards, lists, ranges, steps, and stepped ranges", () => {
    const parsed = parseCron("*/15 0-2,9 1-31/2 1-12 1-5");
    assert.deepEqual([...parsed.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.deepEqual([...parsed.hour].sort((a, b) => a - b), [0, 1, 2, 9]);
    assert.ok(parsed.dayOfMonth.has(1) && parsed.dayOfMonth.has(31) && !parsed.dayOfMonth.has(2));
    assert.equal(parsed.month.size, 12);
    assert.deepEqual([...parsed.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.equal(parsed.domRestricted, true);
    assert.equal(parsed.dowRestricted, true);
  });

  it("treats Sunday as 0 or 7", () => {
    const zero = parseCron("0 0 * * 0");
    const seven = parseCron("0 0 * * 7");
    assert.deepEqual([...zero.dayOfWeek], [0]);
    assert.deepEqual([...seven.dayOfWeek], [0]);
    const all = parseCron("0 0 * * 0-7");
    assert.deepEqual([...all.dayOfWeek].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  });

  it("treats only a lone * as unrestricted DOM/DOW", () => {
    assert.equal(parseCron("0 0 * * *").domRestricted, false);
    assert.equal(parseCron("0 0 * * *").dowRestricted, false);
    assert.equal(parseCron("0 0 */1 * *").domRestricted, true);
    assert.equal(parseCron("0 0 * * 1-5").dowRestricted, true);
  });

  it("rejects invalid expressions cleanly", () => {
    const invalid = [
      "",
      "* * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "1-2-3 * * * *",
      "1-10/0 * * * *",
      "5-1 * * * *",
      "abc * * * *",
      "1,,2 * * * *",
    ];
    for (const expr of invalid) {
      assert.throws(() => parseCron(expr), /Invalid cron expression/);
    }
  });
});

describe("matchesCron", () => {
  it("matches every minute wildcard", () => {
    const date = shanghaiDate(2026, 11, 26, 15, 13, 0);
    assert.equal(matchesCron("* * * * *", date, "Asia/Shanghai"), true);
  });

  it("matches lists, ranges, and steps", () => {
    const date = shanghaiDate(2026, 11, 26, 9, 30, 0);
    assert.equal(matchesCron("30 9 * * *", date, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0,30 8-10 * * *", date, "Asia/Shanghai"), true);
    assert.equal(matchesCron("*/15 9 * * *", date, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 9 * * *", date, "Asia/Shanghai"), false);
  });

  it("uses standard DOM/DOW OR semantics when both are restricted", () => {
    // 2026-11-26 is a Thursday (DOW=4)
    const thursday = shanghaiDate(2026, 11, 26, 0, 0, 0);
    // 1st of month OR Monday at midnight: Thursday the 26th matches neither
    assert.equal(matchesCron("0 0 1 * 1", thursday, "Asia/Shanghai"), false);
    // 26th OR Monday: matches DOM
    assert.equal(matchesCron("0 0 26 * 1", thursday, "Asia/Shanghai"), true);
    // 1st OR Thursday: matches DOW
    assert.equal(matchesCron("0 0 1 * 4", thursday, "Asia/Shanghai"), true);
  });

  it("requires both DOM and DOW when one field is *", () => {
    const thursday = shanghaiDate(2026, 11, 26, 0, 0, 0);
    assert.equal(matchesCron("0 0 26 * *", thursday, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 0 * * 4", thursday, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 0 25 * *", thursday, "Asia/Shanghai"), false);
    assert.equal(matchesCron("0 0 * * 1", thursday, "Asia/Shanghai"), false);
  });

  it("matches Sunday via 0 or 7", () => {
    // 2026-11-22 is a Sunday
    const sunday = shanghaiDate(2026, 11, 22, 8, 0, 0);
    assert.equal(matchesCron("0 8 * * 0", sunday, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 8 * * 7", sunday, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 8 * * 1", sunday, "Asia/Shanghai"), false);
  });

  it("evaluates in the given timezone (Asia/Shanghai vs UTC)", () => {
    // 2026-11-26 01:00 Asia/Shanghai == 2026-11-25 17:00 UTC
    const instant = new Date("2026-11-25T17:00:00.000Z");
    assert.equal(matchesCron("0 1 * * *", instant, "Asia/Shanghai"), true);
    assert.equal(matchesCron("0 1 * * *", instant, "UTC"), false);
    assert.equal(matchesCron("0 17 * * *", instant, "UTC"), true);
    assert.equal(matchesCron("0 17 * * *", instant, "Asia/Shanghai"), false);
  });
});

describe("nextCronTime", () => {
  it("returns the next matching minute strictly after the given instant", () => {
    const before = new Date("2026-11-26T00:30:00.000Z"); // 08:30 Shanghai
    const next = nextCronTime("0 9 * * *", before, "Asia/Shanghai");
    assert.ok(next);
    assert.equal(next.toISOString(), "2026-11-26T01:00:00.000Z");
  });

  it("does not return the current minute when after is exactly on a match", () => {
    const exact = new Date("2026-11-26T01:00:00.000Z");
    const next = nextCronTime("0 9 * * *", exact, "Asia/Shanghai");
    assert.ok(next);
    assert.equal(next.toISOString(), "2026-11-27T01:00:00.000Z");
  });

  it("returns null when nothing matches within maxDays", () => {
    const after = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(nextCronTime("0 0 31 2 *", after, "UTC", 400), null);
  });
});

describe("CronScheduler", () => {
  const schedulers: CronScheduler[] = [];
  after(() => {
    for (const scheduler of schedulers) scheduler.stop();
  });

  function rule(partial: Partial<CronRuleLike> & Pick<CronRuleLike, "name">): CronRuleLike {
    const { trigger, name, enabled, paused } = partial;
    const next: CronRuleLike = {
      name,
      enabled: enabled ?? true,
      trigger: {
        type: "cron",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        ...trigger,
      },
    };
    if (paused !== undefined) next.paused = paused;
    return next;
  }

  it("fires enabled cron rules and returns their names", async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler({
      timezone: "Asia/Shanghai",
      onTrigger: (item) => {
        fired.push(item.name);
      },
    });
    schedulers.push(scheduler);
    scheduler.reload([
      rule({ name: "morning" }),
      rule({ name: "disabled", enabled: false }),
      rule({ name: "paused", paused: true }),
      rule({ name: "webhook", trigger: { type: "webhook" } }),
      rule({ name: "missing-cron", trigger: { type: "cron", cron: undefined } }),
    ]);
    const names = await scheduler.tick(new Date("2026-11-26T01:00:00.000Z"));
    assert.deepEqual(names, ["morning"]);
    assert.deepEqual(fired, ["morning"]);
  });

  it("deduplicates triggers for the same rule and minute", async () => {
    const fired: Date[] = [];
    const scheduler = new CronScheduler({
      onTrigger: (_rule, at) => {
        fired.push(at);
      },
    });
    schedulers.push(scheduler);
    scheduler.reload([rule({ name: "morning" })]);
    const first = await scheduler.tick(new Date("2026-11-26T01:00:10.000Z"));
    const second = await scheduler.tick(new Date("2026-11-26T01:00:50.000Z"));
    const third = await scheduler.tick(new Date("2026-11-26T01:01:00.000Z"));
    assert.deepEqual(first, ["morning"]);
    assert.deepEqual(second, []);
    assert.deepEqual(third, []);
    assert.equal(fired.length, 1);
  });

  it("reports onTrigger errors without throwing from tick", async () => {
    const errors: string[] = [];
    const scheduler = new CronScheduler({
      onTrigger: () => {
        throw new Error("boom");
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    schedulers.push(scheduler);
    scheduler.reload([rule({ name: "morning" })]);
    const names = await scheduler.tick(new Date("2026-11-26T01:00:00.000Z"));
    assert.deepEqual(names, ["morning"]);
    assert.deepEqual(errors, ["boom"]);
  });

  it("start and stop are idempotent", () => {
    const scheduler = new CronScheduler({
      pollIntervalMs: 60_000,
      onTrigger: () => {},
    });
    schedulers.push(scheduler);
    scheduler.start();
    scheduler.start();
    assert.equal(scheduler.running, true);
    scheduler.stop();
    scheduler.stop();
    assert.equal(scheduler.running, false);
  });
});

describe("githubSource", () => {
  const secret = "github-secret";
  const body = JSON.stringify({
    action: "opened",
    number: 42,
    issue: { number: 42 },
    repository: { full_name: "acme/widgets" },
  });

  it("accepts a valid HMAC signature and normalizes the event", () => {
    const signature = `sha256=${sha256Hex(secret, body)}`;
    const result = githubSource.verifyAndParse(
      {
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "deliv-1",
      },
      body,
      secret,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.type, "issues.opened");
    assert.equal(result.events[0]?.lane, "acme/widgets#42");
    assert.equal(result.events[0]?.dedupeKey, "github:deliv-1");
    assert.equal((result.events[0]?.payload as { action?: string }).action, "opened");
  });

  it("rejects missing or invalid signatures when a secret is set", () => {
    const missing = githubSource.verifyAndParse(
      { "X-GitHub-Event": "push" },
      body,
      secret,
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 401);
    }

    const invalid = githubSource.verifyAndParse(
      {
        "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        "x-github-event": "issues",
      },
      body,
      secret,
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.status, 401);

    const noPrefix = githubSource.verifyAndParse(
      {
        "x-hub-signature-256": sha256Hex(secret, body),
        "x-github-event": "issues",
      },
      body,
      secret,
    );
    assert.equal(noPrefix.ok, false);
    if (!noPrefix.ok) assert.equal(noPrefix.status, 401);
  });

  it("skips signature checks when no secret is provided", () => {
    const result = githubSource.verifyAndParse(
      { "x-github-event": "ping" },
      JSON.stringify({ zen: "keep it simple" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events[0]?.type, "ping");
  });

  it("returns 400 for invalid JSON, non-objects, and missing event headers", () => {
    const signatureFor = (raw: string) => `sha256=${sha256Hex(secret, raw)}`;
    const invalidJson = githubSource.verifyAndParse(
      {
        "x-hub-signature-256": signatureFor("{"),
        "x-github-event": "push",
      },
      "{",
      secret,
    );
    assert.equal(invalidJson.ok, false);
    if (!invalidJson.ok) assert.equal(invalidJson.status, 400);

    const arrayBody = "[]";
    const arrayResult = githubSource.verifyAndParse(
      {
        "x-hub-signature-256": signatureFor(arrayBody),
        "x-github-event": "push",
      },
      arrayBody,
      secret,
    );
    assert.equal(arrayResult.ok, false);
    if (!arrayResult.ok) assert.equal(arrayResult.status, 400);

    const missingEvent = githubSource.verifyAndParse(
      { "x-hub-signature-256": signatureFor(body) },
      body,
      secret,
    );
    assert.equal(missingEvent.ok, false);
    if (!missingEvent.ok) assert.equal(missingEvent.status, 400);
  });

  it("builds lanes for pull requests, pushes, and bare repos", () => {
    const prBody = JSON.stringify({
      action: "synchronize",
      pull_request: { number: 7 },
      repository: { full_name: "acme/widgets" },
    });
    const pr = githubSource.verifyAndParse(
      { "x-github-event": "pull_request" },
      prBody,
    );
    assert.equal(pr.ok, true);
    if (pr.ok) assert.equal(pr.events[0]?.lane, "acme/widgets#7");
    if (pr.ok) assert.equal(pr.events[0]?.type, "pull_request.synchronize");

    const pushBody = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "acme/widgets" },
    });
    const push = githubSource.verifyAndParse({ "x-github-event": "push" }, pushBody);
    assert.equal(push.ok, true);
    if (push.ok) {
      assert.equal(push.events[0]?.type, "push");
      assert.equal(push.events[0]?.lane, "acme/widgets:main");
    }

    const repoOnly = githubSource.verifyAndParse(
      { "x-github-event": "star" },
      JSON.stringify({ action: "created", repository: { full_name: "acme/widgets" } }),
    );
    assert.equal(repoOnly.ok, true);
    if (repoOnly.ok) assert.equal(repoOnly.events[0]?.lane, "acme/widgets");
  });
});

describe("gitlabSource", () => {
  const secret = "gitlab-secret";

  it("accepts a matching token and maps issue events", () => {
    const body = JSON.stringify({
      object_kind: "issue",
      object_attributes: { action: "open", iid: 12 },
      project: { path_with_namespace: "acme/widgets" },
    });
    const result = gitlabSource.verifyAndParse(
      {
        "X-Gitlab-Token": secret,
        "X-Gitlab-Event": "Issue Hook",
        "X-Gitlab-Event-UUID": "evt-9",
      },
      body,
      secret,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events[0]?.type, "issue.open");
    assert.equal(result.events[0]?.lane, "acme/widgets#12");
    assert.equal(result.events[0]?.dedupeKey, "gitlab:evt-9");
  });

  it("rejects missing or mismatched tokens when a secret is set", () => {
    const body = JSON.stringify({ object_kind: "push" });
    const missing = gitlabSource.verifyAndParse({ "X-Gitlab-Event": "Push Hook" }, body, secret);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);

    const mismatch = gitlabSource.verifyAndParse(
      { "x-gitlab-token": "nope", "x-gitlab-event": "Push Hook" },
      body,
      secret,
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.status, 401);
  });

  it("maps merge requests, pushes, pipelines, and header fallbacks", () => {
    const mr = gitlabSource.verifyAndParse(
      { "x-gitlab-event": "Merge Request Hook", "x-gitlab-webhook-uuid": "wh-1" },
      JSON.stringify({
        object_kind: "merge_request",
        object_attributes: { action: "merge", iid: 3 },
        project: { path_with_namespace: "acme/widgets" },
      }),
    );
    assert.equal(mr.ok, true);
    if (mr.ok) {
      assert.equal(mr.events[0]?.type, "merge_request.merge");
      assert.equal(mr.events[0]?.lane, "acme/widgets!3");
      assert.equal(mr.events[0]?.dedupeKey, "gitlab:wh-1");
    }

    const push = gitlabSource.verifyAndParse(
      { "x-gitlab-event": "Push Hook" },
      JSON.stringify({
        object_kind: "push",
        ref: "refs/heads/main",
        project: { path_with_namespace: "acme/widgets" },
      }),
    );
    assert.equal(push.ok, true);
    if (push.ok) {
      assert.equal(push.events[0]?.type, "push");
      assert.equal(push.events[0]?.lane, "acme/widgets:main");
    }

    const pipeline = gitlabSource.verifyAndParse(
      { "x-gitlab-event": "Pipeline Hook" },
      JSON.stringify({
        object_kind: "pipeline",
        project: { path_with_namespace: "acme/widgets" },
      }),
    );
    assert.equal(pipeline.ok, true);
    if (pipeline.ok) {
      assert.equal(pipeline.events[0]?.type, "pipeline");
      assert.equal(pipeline.events[0]?.lane, "acme/widgets");
    }

    const fallback = gitlabSource.verifyAndParse(
      { "X-Gitlab-Event": "Push Hook" },
      JSON.stringify({ project: { path_with_namespace: "acme/widgets" } }),
    );
    assert.equal(fallback.ok, true);
    if (fallback.ok) assert.equal(fallback.events[0]?.type, "push");
  });

  it("returns 400 for invalid JSON", () => {
    const result = gitlabSource.verifyAndParse({}, "not-json");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  });
});

describe("generic webhook source", () => {
  const secret = "hook-secret";

  it("accepts HMAC signatures with or without a sha256= prefix", () => {
    const body = JSON.stringify({ type: "deploy.started", lane: "prod", payload: { sha: "abc" } });
    const hex = sha256Hex(secret, body);
    const withPrefix = webhookSource.verifyAndParse(
      { "X-Webhook-Signature": `sha256=${hex}` },
      body,
      secret,
    );
    const withoutPrefix = webhookSource.verifyAndParse(
      { "x-signature-256": hex },
      body,
      secret,
    );
    for (const result of [withPrefix, withoutPrefix]) {
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.events[0]?.type, "deploy.started");
        assert.equal(result.events[0]?.lane, "prod");
        assert.equal((result.events[0]?.payload as { sha?: string }).sha, "abc");
      }
    }
  });

  it("accepts a shared secret via x-webhook-token or Bearer authorization", () => {
    const body = JSON.stringify({ event: "ping" });
    const token = webhookSource.verifyAndParse(
      { "x-webhook-token": secret },
      body,
      secret,
    );
    const bearer = webhookSource.verifyAndParse(
      { authorization: `Bearer ${secret}` },
      body,
      secret,
    );
    assert.equal(token.ok, true);
    assert.equal(bearer.ok, true);
    if (token.ok) assert.equal(token.events[0]?.type, "ping");
  });

  it("returns 401 when neither HMAC nor token matches", () => {
    const body = JSON.stringify({ type: "x" });
    const result = webhookSource.verifyAndParse(
      { "x-webhook-signature": "sha256=00", "x-webhook-token": "nope" },
      body,
      secret,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401);
  });

  it("parses a batch of events and applies header fallbacks", () => {
    const body = JSON.stringify({
      events: [
        { type: "one", dedupeKey: "d1", payload: { n: 1 } },
        { event: "two", lane: "lane-2" },
      ],
    });
    const result = genericSource.verifyAndParse(
      {
        "X-Event-Type": "from-header",
        "X-Idempotency-Key": "idem-9",
      },
      body,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]?.type, "one");
    assert.equal(result.events[0]?.dedupeKey, "d1");
    assert.equal(result.events[1]?.type, "two");
    assert.equal(result.events[1]?.lane, "lane-2");
    assert.equal(result.events[1]?.dedupeKey, "idem-9");
    assert.deepEqual(result.events[1]?.payload, { event: "two", lane: "lane-2" });
  });

  it("falls back to webhook.received and delivery headers for a single event", () => {
    const body = JSON.stringify({ hello: "world" });
    const result = createWebhookSource("custom").verifyAndParse(
      { "x-delivery-id": "del-4" },
      body,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.events[0]?.type, "webhook.received");
    assert.equal(result.events[0]?.dedupeKey, "del-4");
  });

  it("returns 400 for invalid JSON and non-array events", () => {
    const invalid = webhookSource.verifyAndParse({}, "{");
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.status, 400);

    const badBatch = webhookSource.verifyAndParse({}, JSON.stringify({ events: "nope" }));
    assert.equal(badBatch.ok, false);
    if (!badBatch.ok) assert.equal(badBatch.status, 400);
  });
});

describe("source adapter registry", () => {
  it("exposes github, gitlab, custom, webhook, and generic adapters", () => {
    assert.equal(getSourceAdapter("github"), githubSource);
    assert.equal(getSourceAdapter("gitlab"), gitlabSource);
    assert.equal(getSourceAdapter("custom"), webhookSource);
    assert.equal(getSourceAdapter("webhook"), webhookSource);
    assert.equal(getSourceAdapter("generic"), genericSource);
    assert.equal(getSourceAdapter("GitHub")?.name, "github");
    assert.equal(getSourceAdapter("unknown"), undefined);
    assert.equal(sourceAdapters.github?.name, "github");
    assert.equal(webhookSource.name, "custom");
    assert.equal(genericSource.name, "generic");
  });
});
