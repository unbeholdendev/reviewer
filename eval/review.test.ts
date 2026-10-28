import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Review } from "../src/types";
import { cases, score } from "./cases";
import { withCheckout } from "./review";

const head = "a".repeat(40);
const reviews: Review[] = [
  {
    summary: "Expiry units changed.", recommendation: "blocking", addressed: [],
    comments: [{
      path: "expiry.ts", line: 2, side: "RIGHT", severity: "blocking",
      body: "openSession passes ttlSeconds in seconds, but Date.now() uses milliseconds. Sessions now expire 1000 times too soon.",
    }],
  },
  {
    summary: "Ownership check removed.", recommendation: "blocking", addressed: [],
    comments: [{
      path: "permissions.ts", line: 5, side: "RIGHT", severity: "blocking",
      body: "A member can now delete another member's document because ownership is no longer checked.",
    }],
  },
  { summary: "Blank names handled.", recommendation: "looks-good", comments: [], addressed: [] },
  { summary: "The exact-limit rejection is still unresolved.", recommendation: "blocking", comments: [], addressed: [] },
  { summary: "Exact-limit reservations now succeed.", recommendation: "looks-good", comments: [], addressed: [{ commentId: 73, sha: head.slice(0, 7) }] },
];

test("score requires the expected finding, location, trigger evidence and incremental state", () => {
  for (const [index, testCase] of cases.entries()) {
    const good = reviews[index]!;
    assert.deepEqual(score(testCase, good, head), [], testCase.name);
    const reject = (change: (review: Review) => void) => {
      const bad = structuredClone(good);
      change(bad);
      assert.ok(score(testCase, bad, head).length > 0, `Scorer accepted a bad result: ${testCase.name}`);
    };
    reject((review) => { review.recommendation = good.recommendation === "blocking" ? "looks-good" : "blocking"; });
    reject((review) => { review.comments.push({ path: "unrelated.ts", line: 1, side: "RIGHT", severity: "nit", body: "Rename this." }); });
    reject((review) => { review.addressed.push({ commentId: 999, sha: head }); });
    if (testCase.expected.kind === "finding") {
      reject((review) => { review.comments = []; });
      reject((review) => { review.comments[0]!.path = "unrelated.ts"; });
      reject((review) => { review.comments[0]!.line = 99; });
      reject((review) => { review.comments[0]!.side = "LEFT"; });
      reject((review) => { review.comments[0]!.severity = "nit"; });
      reject((review) => { review.comments[0]!.body = "There is a bug here."; });
      reject((review) => { review.comments.push(structuredClone(review.comments[0]!)); });
      for (const pattern of testCase.expected.evidence) {
        assert.ok(pattern.test(good.comments[0]!.body));
      }
      for (const incomplete of index === 0
        ? [
          "Seconds added to Date.now() make sessions expire too soon.",
          "openSession passes a ttl that is added as milliseconds, so sessions expire too soon.",
          "openSession passes ttlSeconds in seconds, so sessions expire too soon.",
          "openSession passes ttlSeconds in seconds, while Date.now() uses milliseconds.",
        ]
        : ["Members can delete documents.", "Another user's document can be deleted.", "A member can read another user's document."]) {
        reject((review) => { review.comments[0]!.body = incomplete; });
      }
    }
    if (testCase.expected.kind === "fixed") {
      reject((review) => { review.addressed = []; });
      reject((review) => { review.addressed[0]!.sha = "b".repeat(40); });
      reject((review) => { review.addressed[0]!.sha = ""; });
      reject((review) => { review.addressed[0]!.commentId = 74; });
    }
  }
});

test("withCheckout generates local files, diffs and logs and removes checkouts on success and errors", async () => {
  for (const testCase of cases) {
    let path = "";
    await withCheckout(testCase, async (checkout, sha) => {
      path = checkout.dir;
      assert.ok(existsSync(path));
      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.ok(checkout.log.includes(sha));
      assert.ok(checkout.log.includes(testCase.message.split("\n")[0]!));
      assert.equal(checkout.incremental, !!testCase.open);
      assert.equal(checkout.rules, "");
      assert.ok(!checkout.log.includes(testCase.name));
      assert.ok(!checkout.diff.includes(testCase.expected.description));
      assert.ok(!path.includes(testCase.name));
      for (const [file, content] of Object.entries({ ...testCase.before, ...testCase.after })) {
        assert.equal(await Bun.file(`${path}/${file}`).text(), content);
      }
      for (const file of Object.keys(testCase.after)) assert.ok(checkout.diff.includes(`diff --git a/${file} b/${file}`));
      if (testCase.name === "Cross-file expiry units") assert.ok(!checkout.diff.includes("sessions.ts"));
      if (testCase.name === "Deliberate ownership bypass") {
        assert.ok(!checkout.diff.includes("README.md"));
        assert.match(await Bun.file(`${path}/README.md`).text(), /Only a document's owner or an admin may delete it/);
      }
      if (testCase.expected.kind === "unresolved") assert.ok(!checkout.diff.includes("quota.ts"));
      if (testCase.open) {
        assert.match(testCase.open.body, /^\*\*blocking:\*\*/);
        assert.ok(!checkout.diff.includes(testCase.open.body));
      }
    });
    assert.ok(!existsSync(path), `Checkout leaked: ${path}`);
  }
  let failedCheckout = "";
  await assert.rejects(withCheckout(cases[0]!, async (checkout) => {
    failedCheckout = checkout.dir;
    throw new Error("callback failed");
  }), /callback failed/);
  assert.ok(failedCheckout && !existsSync(failedCheckout));
});

test("review CLI handles help and invalid arguments without importing agent or requiring auth", () => {
  for (const arg of ["--help", "--unknown"]) {
    const result = Bun.spawnSync(["bun", "eval/review.ts", arg], {
      env: { ...process.env, FORGEJO_URL: "", FORGEJO_TOKEN: "", WEBHOOK_SECRET: "", PI_MODEL: "invalid", PI_API_KEY: "", PI_AUTH_FILE: "/nonexistent/reviewer-eval-auth.json" },
      stdout: "pipe", stderr: "pipe",
    });
    assert.equal(result.exitCode, arg === "--help" ? 0 : 1);
    assert.match(result.stdout.toString() + result.stderr.toString(), /Usage: bun eval\/review.ts/);
  }
});
