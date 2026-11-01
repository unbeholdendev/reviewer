# Issue tracker: Forgejo

Issues and specs live in Forgejo Issues on `unbeholden/reviewer`. Use `tea` from inside the repo, and `tea api <path>` for what it lacks.

## Conventions

- **Create**: `tea issues create --title <title> --description-file <file>`.
- **Read**: `tea issues <index>`, then `tea api repos/unbeholden/reviewer/issues/<index>/comments`.
- **List**: `tea issues list --state <state> --labels <names>`.
- **Comment**: `tea comment <index> <body>`.
- **Labels**: `tea issues edit <index> --add-labels <names>` / `--remove-labels <names>`. List with `tea labels list`. Create missing ones with `tea labels create --name <name> --color <hex>`.
- **Close**: `tea comment`, then `tea issues close <index>`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if external PRs count as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a Forgejo issue with `tea issues create`.

## When a skill says "fetch the relevant ticket"

`tea issues <index>` plus `tea api` on its `comments`.

## Wayfinding operations

- **Map**: one issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog.
- **Child ticket**: `Part of #<map>` at the top of the body, and listed in a task list in the map body. Labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: native Forgejo dependencies, through `tea api` on `repos/unbeholden/reviewer/issues/<index>/dependencies`: `GET` to check, `POST` to add. Unblocked when every blocker is closed.
- **Frontier**: the map's open children with no open blocker and no assignee, first in map order.
- **Claim**: assign to yourself with `tea issues edit <index> --add-assignees <username>`, as the first write.
- **Resolve**: comment the answer, close, then add a gist and link to the map's Decisions-so-far.
