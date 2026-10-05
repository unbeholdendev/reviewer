# reviewer

A code review bot for Forgejo. It reviews pull requests with Claude Code and answers questions in the comments.

## What it does

- Reviews a PR when it is opened, reopened, or taken out of draft (a title that drops its `WIP:` or `[WIP]` prefix). Posts a review with a recommendation, a summary and inline comments.
- Reviews again on each push, looking only at the new commits. A new push cancels a review still running for the old one. Replies "Fixed in …" to its own comments the new commits fix.
- Answers when someone mentions it in a PR comment, or replies in a thread it started.
- Reviews on demand: `@<bot> review again`.
- Skips PRs labelled `no-review`, and lockfiles and vendored code.
- Reacts 👀 when it starts.

It reads `REVIEW.md`, `AGENTS.md` and `CLAUDE.md` from the PR base as the repository's rules.

## Safety

The PR is untrusted. Claude runs in a checkout of the PR head with only Read, Grep and Glob, in `--safe-mode` so it loads no settings, hooks or skills from the PR, and without the Forgejo token or webhook secret in its environment.

## Setup

1. Make a Forgejo user for the bot and a token for it with read and write access to repositories and issues.
2. Get a Claude token with `claude setup-token`.
3. Copy `.env.example` to `.env` and fill it in:

   | Variable | |
   |---|---|
   | `FORGEJO_URL` | your Forgejo, e.g. `https://forgejo.example.com` |
   | `FORGEJO_TOKEN` | the bot user's token |
   | `WEBHOOK_SECRET` | any random string |
   | `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` |
   | `CONCURRENCY` | reviews at once, default 2 |

4. Run it: `docker compose up -d`. It listens on port 3000.
5. Give the bot user access to each repository, and add a webhook to it (or to the org):
   - URL: `http://<host>:3000/webhook`
   - Content type: `application/json`
   - Secret: `WEBHOOK_SECRET`
   - Events: Pull request, Pull request synchronized, and Pull request comments (not Issue comments)

## Development

Needs [Bun](https://bun.sh), git and the `claude` CLI.

```sh
bun install
bunx tsc
bun test
bun src/server.ts
```
