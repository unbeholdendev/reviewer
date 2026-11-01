## Agent skills

### Issue tracker

Forgejo Issues on `unbeholden/reviewer`, via the Forgejo MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Public mirror

Main is mirrored to a public GitHub repo with no check before the push, and
force-pushes cannot reliably remove anything from it. Stage files by name.
Commits, including messages and trailers, must not hold private hosts, public
IPs, employer or client names, or private emails.
