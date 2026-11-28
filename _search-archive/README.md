# nestiworks-search-archive

An [omp](https://omp.sh) utility plugin (not a team mode) that searches your past session transcripts from a slash-command dialog and lets you pick a hit to resume its session.

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
| `/search-archive` | Session titles, your typed messages and the model's text replies |
| `/search-full` | Everything above plus model thinking, tool calls (tool name and argument values) and tool output |

Run either command alone. It opens a dialog in the TUI; type the query there and press Enter. Esc or an empty entry closes the dialog and does nothing.

The dialog shows one line of syntax in its title (`/search-archive: words or --regex "pattern" [--all] [--limit N]`), and these hints appear directly above it while it is open:

- what the command searches (this project by default);
- word matching (see [Matching](#matching));
- `--regex "pattern"` for one regular expression instead of words (see [Regex mode](#regex-mode));
- `--all` to search every project, `--limit N` for at most `N` rows (default 50).

Options may sit anywhere in the typed text, for example `gcloud logging --all --limit 10`. Options without a query (such as `--all` alone) or a `--limit` that is not a whole number from 1 show a warning and run no search.

- **Scope:** sessions of the current project (same working directory) by default; `--all` searches every project. The session you are in is always excluded.
- **Limit:** at most `N` rows (default 50). A note appears only when more matches exist beyond the limit.
- **Order:** sessions newest first (by last write), then rows inside a session newest first by date; a title match is dated at the session start.

### Bare commands only

omp keeps every command line you type in the composer in its prompt history (`history.db` in the profile's agent directory, `~/.omp/agent/history.db` by default; recalled with Up), and agents can read that history through omp's archive tools. A query typed after the command would end up there. So the commands accept nothing after them: not a query, not an option, not even `--help`. Any such text runs no search, opens no dialog, and shows a warning: the text is already saved in the prompt history, agents can read it, and the command must be run alone with the query typed into its dialog. The warning does not repeat the text. The plugin never edits or deletes rows in `history.db`, so a line saved there stays until you remove it.

Run alone, the prompt history holds only `/search-archive` or `/search-full`.

### Privacy

The plugin never saves a search. The query and its results are only shown on screen: they are never written to the session file or any other file, and never sent to the model. (Versions before 1.1.0 posted results as a card that omp saved in the session; those old cards stay in their session files and are not searched.)

### Results

Results open in a picker: a heading with the count, query and scope (plus a note when `--limit` cut more matches), a column header, then one numbered row per hit with its note on the line below.

| Column | Content |
| --- | --- |
| `Session` | First 13 characters of the session id, which `/resume` accepts as a prefix |
| `Project` | Project directory, `~`-abbreviated |
| `Title` | Session title |
| `Date (UTC)` | Message time, `MM-DD HH:MM` |
| `Location` | `/search-full` only: `User message`, `Model reply`, `Model thinking`, `Tool call (<tool>)`, `Tool output (<tool>)` or `Session title` |
| Note | One-line excerpt of about 150 characters around the first hit, under the row |

Move to a row with the arrows and press Enter, or press `1`-`9` to pick rows 1-9 (with many rows, typing filters them). omp's picker also takes a mouse click on a row (with `tui.mouse` on): the first click highlights it, a click on the highlighted row picks it. A session of the current project is resumed right away. A session of another project (from `--all`) prefills the composer with `/resume <session id>` instead, since resuming there moves omp to that project; press Enter to go. If another extension cancels the switch, the same prefill is used. `Esc` closes the picker and changes nothing. No match shows `No results for "<query>"` (`No results for regex "<pattern>"` with `--regex`).

### Outside the TUI

The dialog needs omp's interactive TUI. In RPC, ACP, print and JSON modes no host is known to show it reliably, so either command, with or without text after it, only shows a notice that it needs the interactive TUI and searches nothing. RPC clients show that notice; the other modes drop it.

Tested with omp 19.2.1.

## Matching

- Every query word must start some word of the same message; order and distance do not matter. `gcloud logging` finds a reply that mentions `gcloud` and, elsewhere, `Cloud Logging`.
- Prefix only: `log` finds `Logging`, `ogging` does not.
- Case- and accent-insensitive: `gcloud` finds `GCloud`, `cafe` finds `Café`, `resume` finds `RÉSUMÉ`, `naive` finds `naïve`.
- Punctuation inside a query word matches any punctuation or space, with its parts adjacent: `git-commit` finds `git commit` and `git/commit`.

### Regex mode

With `--regex`, the query is one case-insensitive JavaScript regular expression instead of words. For example, type into the dialog:

```
--regex "deploy.*(staging|prod)"
--regex "error \d{3}" --all
```

- It is matched against each message's raw text: no accent folding and no word-prefix rule, so `ogging` finds `Logging` and `cafe` does not find `Café`. `.` does not cross line breaks; use `[\s\S]` for that.
- `--regex` may sit anywhere among the other options. Wrap the pattern in double quotes to keep its spaces, backslashes and flag-like words (`"a --all b"` is all pattern); the quotes are removed. Unquoted words are joined with one space. Single quotes are literal, and a literal double quote can be written `\x22`.
- An invalid pattern shows a warning such as `Invalid regular expression "(": missing ). Nothing was searched.` and runs no search.
- Patterns that can match empty text (such as `a*`) match every message; the note then centers on the first non-empty hit, or starts at the beginning when there is none.

## How it reads sessions

It streams the session JSONL files under the active profile's `sessions/` directory line by line and never writes to them. Malformed or half-written lines are skipped. Messages relayed by agents or extensions, system notices, and extension cards (including earlier search results) are not searched.

## Tests

```sh
bun test
```

## License

MIT
