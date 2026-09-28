# Issue tracker: Forgejo

Issues and specs live in Forgejo Issues on `pycan/reviewer` (git.unbeholden.dev). Use the Forgejo MCP tools (`mcp__forgejo__*`), owner `pycan`, repo `reviewer`. No CLI is installed.

## Conventions

- **Create**: `create_issue` (title, body).
- **Read**: `get_issue_by_index`, then `list_issue_comments`.
- **List**: `list_repo_issues` with state and label filters.
- **Comment**: `create_issue_comment`.
- **Labels**: `add_issue_labels` / `remove_issue_labels` take numeric label IDs, not names. Get IDs from `list_repo_labels` with `include_org_labels: false` (the token lacks `read:organization`). Create missing ones with `create_repo_label`.
- **Close**: `create_issue_comment`, then `issue_state_change` to closed.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if external PRs count as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a Forgejo issue with `create_issue`.

## When a skill says "fetch the relevant ticket"

`get_issue_by_index` plus `list_issue_comments`.

## Wayfinding operations

- **Map**: one issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog.
- **Child ticket**: `Part of #<map>` at the top of the body, and listed in a task list in the map body. Labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: `add_issue_dependency` (native Forgejo dependencies). Check with `list_issue_dependencies`. Unblocked when every blocker is closed.
- **Frontier**: the map's open children with no open blocker and no assignee, first in map order.
- **Claim**: assign to yourself with `update_issue`, as the first write.
- **Resolve**: comment the answer, close, then add a gist and link to the map's Decisions-so-far.
