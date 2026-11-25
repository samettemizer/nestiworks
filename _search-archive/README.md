# nestiworks-search-archive

An [omp](https://omp.sh) utility plugin (not a team mode) that searches your past session transcripts from slash commands and prefills `/resume` with the best hit.

## Install

In omp:

```
/marketplace add samettemizer/nestiworks
/marketplace install search-archive@nestiworks
```

Then restart the session (extension modules load at session start). It adds no agents and no `/cto`, so it can sit next to any nestiworks team-mode plugin.

For local development, load the working copy for one run with `omp -e ./_search-archive`.

## Commands

| Command | Searches |
| --- | --- |
| `/search-archive <query> [--all] [--limit N]` | Session titles, your typed messages and the model's text replies |
| `/search-full <query> [--all] [--limit N]` | Everything above plus model thinking, tool calls (tool name and argument values) and tool output |

- **Scope:** sessions of the current project (same working directory) by default; `--all` searches every project. The session you are in is always excluded.
- **Limit:** at most `N` rows (default 50). A note appears only when more matches exist beyond the limit.
- **Order:** sessions newest first (by last write), then rows inside a session newest first by date; a title match is dated at the session start.

Results appear as a table in the transcript (shown to you, not sent to the model):

| Column | Content |
| --- | --- |
| `Session` | First 13 characters of the session id, which `/resume` accepts as a prefix |
| `Project` | Project directory, `~`-abbreviated |
| `Title` | Session title |
| `Date (UTC)` | Message time, `MM-DD HH:MM` |
| `Location` | `/search-full` only: `User message`, `Model reply`, `Model thinking`, `Tool call (<tool>)`, `Tool output (<tool>)` or `Session title` |
| `Note` | One-line excerpt of about 150 characters around the first hit |

When there is at least one result, the composer is prefilled with `/resume <first session id>`; press Enter to jump there. Hosts without an editable composer skip the prefill. No match prints `No results for <query>`.

## Matching

- Every query word must start some word of the same message; order and distance do not matter. `gcloud logging` finds a reply that mentions `gcloud` and, elsewhere, `Cloud Logging`.
- Prefix only: `log` finds `Logging`, `ogging` does not.
- Case- and accent-insensitive, Turkish included: `istanbul` finds `İSTANBUL`, `ilik` finds `ılık`, `cafe` finds `Café`.
- Punctuation inside a query word matches any punctuation or space, with its parts adjacent: `git-commit` finds `git commit` and `git/commit`.

## How it reads sessions

It streams the session JSONL files under the active profile's `sessions/` directory line by line and never writes to them. Malformed or half-written lines are skipped. Messages relayed by agents or extensions, system notices, and extension cards (including earlier search results) are not searched.

## Tests

```sh
bun test
```

## License

MIT
