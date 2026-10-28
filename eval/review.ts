import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkout } from "../src/types";
import { cases, score, type Case } from "./cases";

export async function withCheckout<T>(testCase: Case, use: (checkout: Checkout, head: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-eval-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([
      "git", "-C", dir, "-c", "user.name=Author", "-c", "user.email=author@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
    ], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trimEnd();
  };
  try {
    git("init");
    for (const [path, text] of Object.entries(testCase.before)) await Bun.write(join(dir, path), text);
    git("add", ".");
    git("commit", "-m", "Initial implementation");
    for (const [path, text] of Object.entries(testCase.after)) await Bun.write(join(dir, path), text);
    git("add", ".");
    git("commit", "-m", testCase.message);
    return await use({
      dir, diff: git("diff", "HEAD^..HEAD"), log: git("log", "-1"), rules: "",
      incremental: !!testCase.open,
    }, git("rev-parse", "HEAD"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 1 || args[0] !== "--help") throw new Error("Usage: bun eval/review.ts [--help]");
    console.log(`Usage: bun eval/review.ts

Runs five real-model review cases using PI_MODEL and PI_AUTH_FILE or PI_API_KEY.
Uses local temporary Git repositories; no Forgejo or Git network calls.
Prints actual reviews and deterministic scoring failures. Exits nonzero on failures or errors.
Run offline fixture/scoring checks with: bun test eval/review.test.ts`);
    return;
  }
  process.env.FORGEJO_URL ??= "https://forgejo.invalid";
  process.env.FORGEJO_TOKEN ??= "unused-by-eval";
  process.env.WEBHOOK_SECRET ??= "unused-by-eval";
  const { agent } = await import("../src/agent");
  console.log(`Model: ${process.env.PI_MODEL || "openai/gpt-6.1-sol"}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let passed = 0;
  try {
    for (const testCase of cases) {
      if (controller.signal.aborted) break;
      console.log(`\nCASE: ${testCase.name}\nExpected: ${testCase.expected.description}`);
      try {
        const failures = await withCheckout(testCase, async (checkout, head) => {
          const review = await agent.review(checkout, false, testCase.open ? [testCase.open] : [], [], controller.signal);
          console.log(`Actual:\n${JSON.stringify(review, null, 2)}`);
          return score(testCase, review, head);
        });
        if (failures.length) {
          console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
        } else {
          console.log("PASS");
          passed++;
        }
      } catch (error) {
        console.error(`ERROR: ${testCase.name}:`, error);
      }
    }
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  console.log(`\n${passed}/${cases.length} cases passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("ERROR:", error);
    process.exitCode = 1;
  });
}
