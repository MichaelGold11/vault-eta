# vault-eta

A Claude Code mod that tells you how long a run will take and what it costs, learned from your own past runs.

It is built for people who run Claude Code inside a vault or second brain (Obsidian and similar), where the same kinds of tasks come back again and again. It works in any project folder too.

## What you see

**The band.** One row above the prompt, always on. While Claude works:

```
~4m left · 2:10 in · $0.81 · website-work
```

When idle it shows the last run against its estimate and today's total:

```
last wrap 3:40 (est 3-5m, on time) · today $38
```

The time is the run's: from your prompt until Claude and every subagent it started are done, background subagents included and parallel ones counted once, with the time Claude waits on you or the machine sleeps left out. When Claude hands work to a background subagent and stops, the band stays on the run and its clock keeps going until the subagent is back; a stretch where nothing works (a background command running on its own) is not counted. The `last` figure after the run is the same clock, so it matches what the band showed at the end.

The countdown turns yellow when the run passes the usual time and red when it passes the slow time. It pauses and says `waiting on you` while Claude waits for your answer or a permission. In the first runs it says `learning (3 of 5)` instead of guessing. When Claude hands work to subagents in its first two requests, the band adds `subagents, usually longer` and the estimate is matched at once to past runs that did the same, when there are enough of them. The band is drawn under any band another plugin draws, never in its place.

The band in its states (working, handing work to subagents, waiting on you, learning, past the usual estimate, idle):

```
~4m left · 2:10 in · $0.81 · website-work
~4m left · 2:10 in · $0.81 · freeform · subagents, usually longer
waiting on you · 2:10 in · $0.81 · website-work
learning (3 of 5) · 2:10 in · $0.81 · website-work
over usual · 6:40 in · $0.81 · website-work
last wrap 3:40 (est 3-5m, on time) · today $38
```

A GIF of the band and pane in a live session is coming.

**The `/eta` pane.** A side pane with the header (task, project, job), a progress bar, time left with the usual and slow figures, how many past runs it matched, what is running right now, a table of the main agent and each subagent with time, tokens and cost, where the time went (agent, tools, waiting on you), how fast the model is running today, context size, and the cost so far.

The pane while a run works, at 60 columns:

```
website-work · website · job onboarding
███████░░░░░░░░░░░░░  2:10 of ~6:00
~4m left    usual 6m · slow 9m
34 past runs · 82% finished on time

NOW  Bash  bun run build            0:41

WHO            time   tokens     cost
main   opus    1:20    48.2k    $0.61
sonnet x1      0:52    21.0k    $0.18

agent 1:31 · tools 0:39 · waiting on you 0
speed 62 tok/s (usual 70) · eta +8%
context 96.0k · cache warm
$0.81 so far · at API prices
```

## Install

At a terminal prompt inside Claude Code:

```
/plugin install vault-eta --marketplace MichaelGold11/vault-eta
```

From a shell:

```
claude plugin install vault-eta --marketplace MichaelGold11/vault-eta
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `MichaelGold11/vault-eta`, then Add plugin.

## Requirements

A Claude Code version that supports mods, which are plugins with a hooks module (code that draws the band and the pane and listens to events). The docs do not state a minimum version. It was built and tested on Claude Code 2.1.302. If your version does not load it, update Claude Code. Node 18 or newer is only needed for the optional scripts below.

## Commands

| Command | What it does |
| --- | --- |
| `/eta` | Opens the pane, or closes it if it is open. It also opens by itself on a wide terminal when a run starts, unless you closed it. |
| `/eta open` and `/eta close` | Open or close the pane explicitly. |
| `/eta job <name>` | Tags every run after it with a job name (letters, digits and hyphens), so a build that spans many sessions adds up. `/eta job` alone shows the job's totals. |
| `/eta job end` | Stops tagging and shows the job's total. |
| `/eta report` | Writes a Markdown report (by task type, model, project and job, where the time went, accuracy) to the report file. Asked while Claude works, it is written when the run ends. |
| `/eta scorecard` | Writes `vault-eta-scorecard.md`: numbers only (runs, days, accuracy with intervals by shape, cost accuracy, the baseline verdict, drift), with no task, project, path, skill or machine names, so it is safe to paste. |
| `/eta backfill` | Imports what Claude Code already kept in its own transcripts, from inside the mod. Transcripts over 4 MiB are skipped and counted in the toast; `node scripts/backfill.mjs` imports everything. |

None of these print a reply, so nothing they show reaches the model. Answers appear as a short toast. Claude Code lists `/eta` in the typeahead and `/help`; in 2.1.302 it is not in the command list the model reads. Claude Code gives a plugin no switch to keep a command out of that list, so if a later version adds plugin commands to it, the one-line description of `/eta` is what the model would see.

A job tag is kept in the plugin's own store, not in your vault: it applies to every session and every folder on this computer until `/eta job end`.

The report goes to `reportPath` (default `vault-eta-report.md` at the top of the folder the logs live under). It holds task types, project and job names, model names, agent types, tool names, the first words of commands, folder-derived project names, machine ids and costs. In a code repository that is the repository's root, and the file is not ignored by git: set `reportPath` to a folder you ignore, or add the file to your `.gitignore`. The report never overwrites a file it did not write (one without its own frontmatter), never writes through a symbolic link, and never writes outside the folder.

## Importing past history

On day one the mod has no history, so the first estimates say `learning`. You can import what Claude Code already kept in its own transcripts. Clone this repository, then from its folder:

```
node scripts/backfill.mjs --vault ~/notes --machine laptop
```

`--vault` is your vault (or project) folder. The transcripts are found under `~/.claude/projects/` from the vault path. `--machine` is a name for this computer, and is required. Add `--dry-run` to see the totals without writing anything. Other options: `--projects-dir <dir>` if your transcripts are somewhere else (for example when you set `CLAUDE_CONFIG_DIR`), `--ignore "skill-a, skill-b"` and `--projects-folder Projects`, which work like the options below. `bun scripts/backfill.mjs` works the same way.

Windows paths such as `C:\Users\you\notes` are handled by the same rules (every character that is not a letter or digit becomes a dash in the transcripts folder name). That path handling was written from how Claude Code names those folders and covered by tests, but I could only run it on macOS.

The import writes one row per prompt for the main agent and one per subagent, not one per turn, so an imported run is timed from its timestamps: a stretch of over 10 minutes with no model request or tool call in flight (Claude waiting for a background subagent, a subagent resumed later) is not counted.

Run it again any time: it replaces its own `backfill-YYYY-MM.jsonl` and `.partN` files (nothing else in the folder) and skips runs the live mod already logged. It stores the same fields as the live log (below). It writes and deletes nothing when `.vault-eta`, `runs`, the machine folder, the ignore file or one of its files is a symbolic link, or when a path would land outside the vault.

## How it learns

Plain statistics on local logs. No model is called.

1. Every run is logged: its task type, project, model, how long it ran (Claude and its subagents on the band's clock), the cost and the steps taken.
2. A new run is matched with past runs of the same task type, project and model (falling back to fewer of those when there are too few). Under five matches it says `learning`.
3. At submit it shows the median ("usual") and the 80th percentile ("slow") of the last 50 matches.
4. As the run goes it re-estimates: of past runs like this one that were still going at this point, how much longer did they take? It also uses steps done, the agent's task list when it writes one, and the model's speed today.
5. It scores itself by replaying every past run against only the runs that ended before it started (each against the last 500 runs of its task type), and corrects its slow figure toward the 80% target. The score is made when the session starts and again while Claude is idle, never while a run works.

A task type is the first skill that names the run, else the slash command, else `freeform`. A skill that only hands over to another skill (it loads, then another skill loads before any other tool call) is treated as a router and does not name the run. Helper skills such as browser or charting skills do not name a run either.

Honest accuracy: it is rough when you hit enter and gets tighter as the run goes. As an example, replaying about 1,100 runs of one person's vault over six weeks, the typical miss of the usual figure was a factor of 2.4 at submit and 1.8 after five requests, and the slow figure held (the run finished under it) 73% of the time at submit and about 80% once the run's labels are known, against a target of four in five. The report and scorecard use each run's final labels, so they show the higher figure (80%, a miss of 2.2 on the live log); the 73% and 2.4 are what you see at submit. Against two naive predictors (the usual time of the task type, and one global figure), scored on held-out runs with an interval score that punishes wide ranges and overruns, the matcher's slow figure is about a tie on time and a small edge on cost, and the verdicts against the per-type median are "unclear" by the rule the report applies (the miss factors in the report's table are in-sample, so read them as a description, not a test), and `/eta report` prints the verdict for your own history. The weak spot is runs that hand work to subagents: they finish under the slow figure about a quarter of the time when the estimate is made at submit, and about four times in five once the run has shown it uses subagents. Repeated tasks do better than one-off work. Your numbers will differ. To replay your own history from a shell: `node scripts/label-eval.mjs --vault ~/notes`.

## What it stores and where

Logs go to `.vault-eta/runs/<machine>/` in your vault, or in the project folder: it looks upward from where the session started for a folder that already has `.vault-eta`, else one with `.git`, else it uses the start folder, and it never climbs into your home folder from below. `<machine>` is a random id made once per computer.

- One file per session: `<date>-<session>.jsonl`, named by the day it started.
- Past 512 KiB a session goes on in `<date>-<session>.part2.jsonl` and so on.
- A session reloaded or resumed on a later day starts a file named by that day.
- Two sessions open in the same vault write separate files.
- `backfill-YYYY-MM.jsonl` files come from the optional import below.

`.vault-eta` has its own `.gitignore` containing `*`, so the logs are never committed by accident. It is written whenever it is missing, checked before every write, so deleting the whole folder is safe: the next write puts it back first. To commit your logs on purpose, empty that file rather than delete it.

If `.vault-eta`, `runs`, the machine folder or a log file is a symbolic link, or a path would land outside the folder, the mod writes no log for that session (and reads no history through it), and says so once.

Each row (one per turn of the main agent or of a subagent) holds:

- times: start and end, agent time, model time, tool time, time waiting on you, machine sleep;
- each model request: when it started, time to the first token, tokens per second, token counts, cost, stop reason, characters of thinking;
- each tool call: its name, when it started and how long it took, whether it was asked or failed, and the safe facts below;
- the model, effort, agent type, subagent ids, token counts and cost of the turn;
- the task labels: the task type (a skill's or slash command's name), the project (a folder name), the job tag;
- the prompt's length in characters and where it came from (typed, SDK, a background result), never its text;
- conditions: the permission mode, the hour, weekday and time zone offset, the Claude Code version, the name of the folder the logs live in, the context size, whether the cache was warm, compactions;
- the estimate the band showed, so the report can score it.

It never stores prompt text, file contents, tool output, error messages or subagent prompts. Tool calls keep only these facts:

- a shell command: the command's name, plus up to two more words from a fixed list of known subcommands (`git push`, `bun run build`, `gh pr create`), or a script's file name after an interpreter (`node backfill.mjs`). Never its arguments, flags, paths, hosts or values;
- a file tool: the folder inside your vault, up to four levels, never the file's name. A path outside the vault is stored as `(outside)`;
- an edit: how many lines it added and removed;
- a skill or subagent call: the skill's name or the agent type, never its arguments or prompt;
- MCP and other tools: the tool's name only.

## Cost

Dollars are "at API prices": what the same tokens would cost on the Anthropic API at list prices, not what a subscription bills you. The price table is in `lib/price.mjs`. A model that is not in the table is never guessed: a cost with nothing priced shows `--`, and a total that leaves some unpriced work out shows `+` (`$0.81+`), in the band, the pane, the job toast and the report. Cache writes are priced at the TTL you choose in the options, since live usage does not say which one was used.


**How close it is to `/cost`.** The cost shown is the sum of the turns the mod saw: the main loop and every subagent. Token counts match Claude Code's own request by request. Two things keep the sum from equalling `/cost`. First, `/cost` also counts Claude Code's own background requests (the auto-mode check, memory extraction, summaries, web searches), which belong to no turn: about 13% to 29% of `/cost` in long sessions with many subagents. Second, the live feed does not say whether a cache write was the 5-minute or the 1-hour kind, so the mod prices every live write at the 1-hour rate; subagents in practice write 5-minute caches, so subagent cost runs high. In one person's logs, short sessions (under $10) landed within 5% of `/cost` about three times in four, and long ones with subagents landed at 80% to 98% of it. Treat the dollars as an honest estimate of the turns, not as the bill. The session row's `engineUsd` is the exact `/cost` total, next to `loggedUsd`, the figure the band and report add up.
## Overhead

- Model tokens: zero. The mod never calls a model and adds nothing to your prompts.
- Network: none. It makes no network calls. If your vault sits in a synced folder (iCloud, Dropbox, OneDrive), the sync service uploads `.vault-eta` like any other folder.
- Time: two waits remain. `session.end` waits for the last log write, within the engine's exit limit, and `turn.complete` waits for a pending run open. Every event passes through unchanged, and the band's refresh and the other log writes run after it. At session start it reads the last 90 days of logs (about 9 MiB and 100 ms for a heavy user) and scores them (about 20 ms); the score is made again while Claude is idle.
- It runs no processes. It reads only your folder, the names of the folders above it (to find where `.vault-eta` belongs), and, for the optional backfill script, Claude Code's own `~/.claude/projects/`.

## Options

Set them with `claude plugin configure vault-eta` or in the plugin's settings.

| Option | Default | What it does |
| --- | --- | --- |
| `cacheWriteTtl` | `1h` | Prices cache writes at the 1 hour or 5 minute rate. Use `5m` if your sessions use short caches. |
| `ignoreSkills` | empty | Comma-separated skills that never name a task. Add one here if a router skill still names runs it should not. |
| `projectsFolder` | empty | The folder that holds one folder per project, relative to your vault (`Projects`, `Work/Clients`). Empty detects a top-level folder called `projects`, any case, with an optional number prefix, so `Projects`, `01-projects` and `1 Projects` all work. A run's project is the folder it edited or read most. A skill called `<name>-work` also sets the project to `<name>`. |
| `reportPath` | `vault-eta-report.md` | Where `/eta report` writes, relative to the folder the logs live under. It must be a relative `.md` path that stays inside that folder (no `..`, no drive, not in `.git` or `.vault-eta`). |

## Uninstall

```
/plugin uninstall vault-eta
```

or `claude plugin uninstall vault-eta`. What stays behind, for you to delete if you want it gone:

- the `.vault-eta` folder in your vault (or project folder), with the logs;
- any report note `/eta report` wrote (`vault-eta-report.md` by default);
- the plugin's store entry in Claude Code's configuration folder, which holds the machine id and the job tag.

## Developing

Run the tests with `claude plugin test .` from a clone. Type-checking needs the engine's type declarations: Claude Code writes them to `.claude-plugin/types/` (ignored by git) when it loads the mod from a folder it hot-reloads, for example `claude --plugin-dir <your clone>`. After that, `npx -p typescript tsc -p . --noEmit` checks everything; leave out `--noEmit` and tsc writes `.js` files next to the sources.

## License

MIT. See `LICENSE`.
