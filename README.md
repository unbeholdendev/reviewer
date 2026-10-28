# reviewer

A code review bot for Forgejo. It reviews pull requests with Pi and answers questions in the comments.

## What it does

- Reviews a PR when it is opened, reopened, or taken out of draft (a title that drops its `WIP:` or `[WIP]` prefix). Posts a review with a recommendation, a summary and inline comments.
- Reviews again on each push, looking only at the new commits. A new push cancels a review still running for the old one. Replies "Fixed in …" to its own comments the new commits fix.
- Answers when someone mentions it in a PR comment, or replies in a thread it started.
- Reviews on demand: `@<bot> review again`.
- Skips PRs labelled `no-review`, and lockfiles and vendored code.
- Reacts 👀 when it starts.

It reads `REVIEW.md` and `AGENTS.md` from the PR base as the repository's rules.

## Safety

The PR is untrusted. The bot embeds Pi’s SDK with only `read`, `grep`, `find` and `ls`. These tools reject paths and symlinks outside the checkout. Project settings, context files, extensions, MCP, skills and prompt templates are not loaded. Repository rules come from the PR base, not its head.

Sessions and settings stay in memory. Subscription credentials are stored outside the checkout and refreshed by the SDK. Pi runs inside the server process, not a sandbox. Run the bot in a dedicated container with only the credentials and repositories it needs.

## Setup

1. Make a Forgejo user for the bot and a token for it with read and write access to repositories and issues.
2. Use your OpenAI subscription, or set `PI_API_KEY` for API billing.
3. Copy `.env.example` to `.env` and fill it in:

   | Variable | |
   |---|---|
   | `FORGEJO_URL` | your Forgejo, e.g. `https://forgejo.example.com` |
   | `FORGEJO_TOKEN` | the bot user's token |
   | `WEBHOOK_SECRET` | any random string |
   | `PI_MODEL` | exact `provider/model-id` from Pi’s built-in catalog; defaults to `openai/gpt-6.1-sol` (GPT-6.1 SOL) |
   | `PI_AUTH_FILE` | subscription credential file, default `credentials/auth.json` |
   | `PI_API_KEY` | optional API key; if set, saved credentials are not read |
   | `CONCURRENCY` | reviews at once, default 2 |

4. Run `./deploy.sh` in a terminal. It pulls the image, checks authentication, asks you to sign in if needed, then starts the bot on port 3000.
5. Give the bot user access to each repository, and add a webhook to it (or to the org):
   - URL: `http://<host>:3000/webhook`
   - Content type: `application/json`
   - Secret: `WEBHOOK_SECRET`
   - Events: Pull request, Pull request synchronized, and Pull request comments (not Issue comments)

## Deployment and subscription login

Run `./deploy.sh` on the deployment host. Docker Compose is the only host dependency; Pi’s SDK handles login inside a one-off container.

- A usable saved subscription login is reused without prompting. Expired tokens are refreshed and saved.
- If the login is missing or cannot be refreshed, the command prints an OpenAI sign-in URL. Open it in your browser and sign in with your subscribed account.
- The browser redirects to a localhost URL. Because login runs in a container, that page may not load. Copy the full final URL from the browser’s address bar and paste it into the deployment terminal. No callback port needs to be exposed.
- Only after login succeeds does deployment start or update the service. A failed or cancelled login leaves an already running service alone.

Unattended deployment works with usable saved credentials or `PI_API_KEY`. If a new subscription login is needed without a terminal, deployment fails with an instruction to rerun interactively rather than hanging.

The login check can also be run on its own:

```sh
docker compose run --rm reviewer bun src/login.ts
```

Do not commit or share the credential files, or reuse them in another agent. The check resolves credentials and refreshes expired tokens; it does not make a model request. To force a fresh login before token expiry, remove only `credentials/auth.json` and rerun `./deploy.sh`. Keep `device-id`.

Leave `PI_API_KEY` unset or empty. The default model is `openai/gpt-6.1-sol`. The SDK uses the subscription login, refreshes access tokens, and saves rotated credentials. Your plan’s limits and OpenAI’s terms still apply.

Compose mounts only `./credentials` at `/app/credentials`. It holds `auth.json` and a stable `device-id` required by OpenAI’s login flow. The directory must stay writable for token refresh and file locks. This persists the login across container restarts without mounting Pi’s configuration or sessions. No Pi CLI is installed or run.

For API billing instead, set `PI_API_KEY` to a key from [OpenAI API keys](https://platform.openai.com/api-keys), or from your chosen provider. This bypasses the credential file; API usage is billed separately from your subscription.

## Development

Needs [Bun](https://bun.sh), git, ripgrep and fd (`fd-find` on Debian). Pi is a pinned application dependency. Set the variables above in `.env`.

```sh
bun install
bunx tsc
bun test
bun src/server.ts
```

### Review quality eval

Run the five real-model cases separately from the offline tests:

```sh
bun eval/review.ts
```

This calls `agent.review` with the current prompts and your `PI_MODEL` and `PI_AUTH_FILE` or `PI_API_KEY` settings. It makes model requests and may incur API charges. Use a provider-qualified model such as `openai/gpt-6.1-sol` and the subscription setup above, or an API key. `bun eval/review.ts --help` needs no credentials.

The eval creates local Git repositories, generates diffs and commit logs, and removes each checkout after the review, including on errors. It does not contact Forgejo or fetch Git repositories. Missing Forgejo-only environment variables get inert defaults; model and auth settings are unchanged. Case names and expected findings stay outside the model's input.

The cases in `eval/cases.ts` define these outcomes:

| Case | Expected result |
|---|---|
| Cross-file expiry units | Block on the changed calculation: an unchanged caller passes seconds, but the result uses milliseconds. |
| Deliberate ownership bypass | Block on members deleting another user's document, despite the author's explanation. The checkout's unchanged permissions contract allows only owners and admins. |
| Clean blank-name handling | `looks-good`, no findings. |
| Incremental unresolved quota finding | Keep `blocking` without repeating or marking the open finding addressed, even though its file is absent from the new diff. |
| Incremental fixed quota finding | `looks-good`, no new findings; mark the open finding addressed with the fixing commit's SHA. |

The runner prints each expected outcome, the full actual review, scoring failures and a pass count. Any failed case or error exits nonzero. Bug findings must have blocking severity, the expected file and line region, and text matching every trigger-evidence regex listed in `eval/cases.ts`. Extra findings fail, including on the clean control. These deterministic checks use no LLM judge. Regexes can reject a valid paraphrase or accept a misleading explanation that contains the expected words; read the printed findings before drawing conclusions. Five small cases do not establish general review quality.

Fixture and scoring checks run offline as part of `bun test`, or on their own:

```sh
bun test eval/review.test.ts
```
