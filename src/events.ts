import { z } from "zod";
import { reply, review } from "./review";
import { type Adapters, ForgejoPull, ForgejoUser, type PR, toPull } from "./types";

const Repository = z.object({ name: z.string(), owner: ForgejoUser });

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number(),
  changes: z.object({ title: z.object({ from: z.string() }).optional() }).optional(),
  pull_request: ForgejoPull.extend({
    state: z.string(),
    draft: z.boolean().optional(),
    labels: z.array(z.object({ name: z.string() })).nullish(),
  }),
  repository: Repository,
});

const IssueCommentEvent = z.object({
  action: z.string(),
  is_pull: z.boolean(),
  issue: z.object({ number: z.number() }),
  comment: z.object({ id: z.number(), body: z.string() }),
  repository: Repository,
});

const Sender = z.object({ sender: ForgejoUser });

export type Job = { pr: PR; cancellable: boolean; pushed?: boolean; run: (signal: AbortSignal) => Promise<void> };

export function handle(adapters: Adapters, event: string | undefined, payload: unknown): Job | undefined {
  if (Sender.safeParse(payload).data?.sender.login === adapters.forgejo.login) return;
  if (event === "issue_comment") return commented(adapters, payload);
  if (event !== "pull_request") return;
  const parsed = PullRequestEvent.safeParse(payload);
  if (!parsed.success) return;
  const { action, changes, number, pull_request, repository } = parsed.data;
  if (pull_request.labels?.some((l) => l.name === "no-review")) return;
  // Forgejo has no ready-for-review action: a draft is a title with a WIP prefix
  const undrafted = action === "edited" && /^(wip:|\[wip\])/i.test(changes?.title?.from ?? "");
  const pushed = action === "synchronized";
  if (
    pull_request.draft ||
    pull_request.state !== "open" ||
    !(["opened", "reopened"].includes(action) || undrafted || pushed)
  )
    return;
  const pr = { owner: repository.owner.login, repo: repository.name, number };
  const pull = toPull(pull_request);
  return { pr, cancellable: true, pushed, run: (signal) => review(adapters, pr, pull, pushed, signal) };
}

function commented(adapters: Adapters, payload: unknown): Job | undefined {
  const parsed = IssueCommentEvent.safeParse(payload);
  if (!parsed.success) return;
  const { action, is_pull, issue, comment, repository } = parsed.data;
  const login = adapters.forgejo.login.replaceAll(".", "\\.");
  if (action !== "created" || !is_pull) return;
  // not part of an email or a longer login; a trailing full stop ends the sentence
  const mention = `(^|[^\\w@])@${login}`;
  const mentioned = new RegExp(`${mention}(?![\\w-]|\\.\\w)`, "i").test(comment.body);
  const rest = comment.body.replace(new RegExp(`${mention}[\\s,:]+review\\s+again\\b`, "i"), "$1");
  const pr = { owner: repository.owner.login, repo: repository.name, number: issue.number };
  if (rest === comment.body) return { pr, cancellable: false, run: () => reply(adapters, pr, comment, mentioned) };
  return {
    pr,
    cancellable: true,
    async run(signal) {
      await review(adapters, pr, await adapters.forgejo.pull(pr), false, signal, comment.id);
      if (/\w/.test(rest) && !signal.aborted) await reply(adapters, pr, comment, true);
    },
  };
}
