import { CONCURRENCY } from "./env";
import type { Job } from "./events";

export function createQueue() {
  const pending = new Set<Promise<unknown>>();
  const waiting: (() => void)[] = [];
  const tails = new Map<string, Promise<unknown>>();
  const reviews = new Map<string, AbortController>();
  let running = 0;

  async function limited(fn: () => Promise<void>) {
    if (running < CONCURRENCY) running++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      await fn();
    } finally {
      // pass the slot on without freeing it, so a newcomer can't jump the queue
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }

  function schedule({ pr, cancellable, pushed, run }: Job) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (pushed && reviews.has(key)) console.log(`${key}: new push, cancelling the running review`);
    if (pushed) reviews.get(key)?.abort();
    if (pushed || !reviews.has(key)) reviews.set(key, new AbortController());
    const controller = cancellable ? reviews.get(key)! : new AbortController();
    const job = (tails.get(key) ?? Promise.resolve())
      .then(() =>
        limited(async () => {
          const start = Date.now();
          console.log(`${key}: job started, ${waiting.length} waiting`);
          await run(controller.signal);
          console.log(`${key}: job ${controller.signal.aborted ? "cancelled" : "done"} in ${Date.now() - start}ms`);
        }),
      )
      .catch((e) => {
        if (controller.signal.aborted) console.log(`${key}: job cancelled`);
        else console.log("webhook job failed:", e);
      })
      .finally(() => {
        pending.delete(job);
        if (tails.get(key) !== job) return;
        tails.delete(key);
        reviews.delete(key);
      });
    tails.set(key, job);
    pending.add(job);
  }

  async function idle() {
    while (pending.size) await Promise.all(pending);
  }

  return { schedule, idle };
}
