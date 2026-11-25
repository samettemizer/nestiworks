# nestiworks-search-archive

An [omp](https://omp.sh) utility plugin (not a team mode) that searches your past session transcripts from slash commands and lets you pick a hit to resume its session.

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
| `/search-archive [<query> [--all] [--limit N]]` | Session titles, your typed messages and the model's text replies |
| `/search-full [<query> [--all] [--limit N]]` | Everything above plus model thinking, tool calls (tool name and argument values) and tool output |

Run either command bare (`/search-archive`, `/search-full`) to type the query, with the same `--all` / `--limit N` options, into a dialog. Esc or an empty entry closes the dialog and does nothing. The bare form needs the TUI; elsewhere it shows the usage line.

- **Scope:** sessions of the current project (same working directory) by default; `--all` searches every project. The session you are in is always excluded.
- **Limit:** at most `N` rows (default 50). A note appears only when more matches exist beyond the limit.
- **Order:** sessions newest first (by last write), then rows inside a session newest first by date; a title match is dated at the session start.

The plugin never saves a search. The query and its results are only shown on screen: they are never written to the session file or any other file, and never sent to the model. (Versions before 1.1.0 posted results as a card that omp saved in the session; those old cards stay in their session files and are not searched.)

omp itself does keep every command line you type in the composer in its prompt history (`~/.omp/agent/history.db`, recalled with Up), and that includes an inline query such as `/search-archive my query`. To keep the query out of every file, run the command bare and type the query in the dialog: the history then holds only `/search-archive`.

In the TUI, results open in a picker: a heading with the count, query and scope (plus a note when `--limit` cut more matches), a column header, then one numbered row per hit with its note on the line below.

| Column | Content |
| --- | --- |
| `Session` | First 13 characters of the session id, which `/resume` accepts as a prefix |
| `Project` | Project directory, `~`-abbreviated |
| `Title` | Session title |
| `Date (UTC)` | Message time, `MM-DD HH:MM` |
| `Location` | `/search-full` only: `User message`, `Model reply`, `Model thinking`, `Tool call (<tool>)`, `Tool output (<tool>)` or `Session title` |
| Note | One-line excerpt of about 150 characters around the first hit, under the row |

Move to a row with the arrows and press Enter, or press `1`-`9` to pick rows 1-9 (with many rows, typing filters them). omp's picker also takes a mouse click on a row (with `tui.mouse` on): the first click highlights it, a click on the highlighted row picks it. A session of the current project is resumed right away. A session of another project (from `--all`) prefills the composer with `/resume <session id>` instead, since resuming there moves omp to that project; press Enter to go. If another extension cancels the switch, the same prefill is used. `Esc` closes the picker and changes nothing. No match shows `No results for "<query>"`.

Outside the TUI (RPC, ACP, print and JSON modes), results are sent as one plain-text notification, which RPC clients show and the other modes drop. Hosts with an editable composer also get `/resume <first session id>` prefilled. Nothing is saved in any mode.

Tested with omp 19.2.1.

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
