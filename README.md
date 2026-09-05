# omp-learn-org

A one-to-one AI teacher for [OMP](https://github.com/oh-my-pi/oh-my-pi), wired into Emacs Org-mode and Anki.

You say what you want to understand. It first *quizzes you* to find the edge of what you already know, plans a
dependency graph from foundations up to your goal, shows you that plan before teaching anything, then teaches one
reasoning step at a time — checking with a graded question after every step. Everything you see is written into a
timestamped Org file that opens in your running Emacs, with LaTeX and diagrams rendered. Every quiz also produces
a flashcard appended to your Anki Org file.

This is a port of [amosblomqvist/learn](https://github.com/amosblomqvist/learn) (see the author's video,
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU)) from pi to OMP, with Obsidian and
Markdown replaced by Emacs and Org-roam, tmux replaced by Zellij, and spaced repetition added. See
[NOTICE.md](NOTICE.md) for what is derived from where.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Requirements](#requirements)
3. [Install](#install)
4. [Zellij in five minutes](#zellij-in-five-minutes)
5. [First lesson, step by step](#first-lesson-step-by-step)
6. [The daily loop](#the-daily-loop)
7. [Commands](#commands)
8. [What it may and may not read](#what-it-may-and-may-not-read)
9. [Anki cards](#anki-cards)
10. [Making it yours](#making-it-yours)
11. [Troubleshooting](#troubleshooting)

---

## What you get

- **`/lesson <goal>`** — starts a logged teaching session. A new `.org` file is created in your learning
  directory and opened in Emacs; from then on every message, question, and answer lands in it.
- **Graded quizzes** — a popup with options, an always-present *I don't know* choice (which is recorded as a real
  knowledge gap, not a wrong guess), and a note field. You answer, it grades instantly and explains.
- **Verified diagrams** — when a picture helps, a maker agent writes the diagram, renders it, *looks at the PNG*,
  fixes it, and only then hands it over. It shows up inline in the Org log.
- **A researcher** — before planning, and any time it is unsure of a fact, it dispatches a research session
  instead of guessing.
- **Visible child sessions** — those agents are not hidden background jobs. Each one opens as a real OMP session
  in its own Zellij pane. You can watch it, type into it, interrupt it, and resume it later.
- **Anki export** — every quiz carries a self-contained question/answer pair that is appended to your Anki Org
  file under a heading you choose.

## Requirements

| Thing | Why | Check |
|---|---|---|
| [OMP](https://github.com/oh-my-pi/oh-my-pi) ≥ 18.1.10 | the harness | `omp --version` |
| [Bun](https://bun.sh) ≥ 1.3.14 | runs the extension | `bun --version` |
| Emacs with a running server | the learning log and Anki writes go through `emacsclient` | `emacsclient --eval t` prints `t` |
| [Pandoc](https://pandoc.org) | converts the session to Org | `pandoc --version` |
| [Zellij](https://zellij.dev) | panes for child sessions | `zellij --version` |
| Chrome or Chromium | Mermaid rendering | any installed Chrome |
| `rsvg-convert` (librsvg) or ImageMagick | SVG rendering | `rsvg-convert --version` |
| Anki + [anki-editor](https://github.com/anki-editor/anki-editor) or `org-anki` | pushing cards into Anki | optional |

macOS with Homebrew:

```bash
brew install bun pandoc zellij librsvg
```

Nix / NixOS — add to your profile or `home.packages`:

```nix
[ pkgs.bun pkgs.pandoc pkgs.zellij pkgs.librsvg ]
```

**Emacs server.** If `emacsclient --eval t` fails, add `(server-start)` to your config (Doom users: it is on by
default when you launch the Emacs application; otherwise `M-x server-start`).

## Install

While this repository is private (see [NOTICE.md](NOTICE.md)), install it over SSH — you need a GitHub account
with access and an SSH key on the machine:

```bash
omp plugin install git+ssh://git@github.com/donvini94/omp-learn.git
```

If it is ever made public, the shorter form works too:

```bash
omp plugin install github:donvini94/omp-learn
```

That downloads the package and its dependencies. To update later, run the same command again. To remove it:
`omp plugin uninstall omp-learn-org`.

Then create your workspace — start `omp` anywhere and run:

```
/lesson-setup
```

It asks three things and writes a config file:

- **Shared learning directory** — where lesson logs live. If you use Org-roam, a subdirectory of your roam
  directory is a good choice, e.g. `~/org/roam/learning`. It is created if missing.
- **Anki Org file** — an existing Org file where flashcards get appended. Leave blank to disable card export.
- **Anki deck** — the deck name written into each card, e.g. `Learning`.

The result is `<learningDir>/.omp/learn.json`:

```json
{
  "learningDir": "/Users/you/org/roam/learning",
  "ankiFile": "/Users/you/org/anki.org",
  "ankiHeading": "Dispatch Shelf",
  "ankiDeck": "Learning"
}
```

`ankiHeading` is the top-level heading in your Anki file that new cards are filed under; it is created if it does
not exist, and nothing else in that file is touched. Optional extra keys: `emacsclient`, `pandoc`,
`browserExecutable` (absolute paths, if they are not on your `PATH`).

**Important:** the teacher only activates when OMP is started *inside the learning directory*. That is where the
config is found.

## Zellij in five minutes

Zellij is a terminal multiplexer: one terminal window split into several panes, all surviving independently. This
package needs it because child agents run as real terminal sessions you can watch and talk to.

Start a named session and run OMP inside it:

```bash
cd ~/org/roam/learning
zellij --session learning
```

You now have one pane with a shell. Run `omp` in it. That is your teacher.

The five keys that matter (defaults):

| Keys | Does |
|---|---|
| `Ctrl+p` then `←/→/↑/↓` | move focus between panes |
| `Ctrl+p` then `x` | close the focused pane |
| `Ctrl+p` then `f` | make the focused pane fullscreen (press again to restore) |
| `Ctrl+o` then `d` | detach — everything keeps running in the background |
| `Ctrl+q` | quit Zellij and everything in it |

To come back after detaching: `zellij attach learning`. To see what is running: `zellij list-sessions`.

When the teacher spawns a researcher or a diagram maker, a new pane appears with that agent's name in its title.
You can ignore it, or focus it and read along. When it finishes, its pane's session ends and its summary is
delivered to the teacher automatically — you do not have to do anything.

> Prefer tmux, WezTerm, or cmux? They work too; the backend picks whichever one you started OMP inside. Force one
> with `PI_SUBAGENT_MUX=tmux`.

## First lesson, step by step

1. `cd ~/org/roam/learning` and start `zellij --session learning`.
2. Run `omp`. Pick a strong model — teaching quality tracks model quality closely (`Ctrl+p` in OMP cycles models).
3. Type `/lesson I want to understand how TLS actually protects a connection`.
   - A new Org file is created and opened in Emacs. Put that Emacs window next to your terminal — it is the
     comfortable, rendered view of the same session.
4. **Probe.** You will get a run of quiz popups. Arrow keys select, `Enter` answers. `Tab` focuses the note field
   if you want to add a short aside. Answer honestly and use *I don't know* freely — a wrong guess and a genuine
   gap teach it different things. This phase is deliberately long: it is mapping the edge of what you know.
   Anything longer than a short note — reasoning you want to talk through, including dictated — belongs in the
   normal composer as an ordinary message, before or after the popup.
5. **Goal.** It will ask, without grading, what you actually want out of the topic. Be concrete.
6. **Plan.** It researches the topic in a child pane, then shows you a plan in prose plus a dependency diagram:
   foundations at the roots, your goal at the sink. **It stops here and waits.** Read the plan. If a root looks
   wrong or the scope is off, say so now — this is the cheap moment to fix it.
7. **Teach.** Say go. It works down the graph one node at a time: motivate, establish, connect to what you
   already have, then a quiz to confirm that node landed. Interrupt whenever you like, ask anything.
8. **Final check.** When the graph is built it runs one holistic check on the goal itself — teach-back, a broken
   scenario to diagnose, a design decision to defend, or code to write, whichever matches your goal.

Everything from steps 3–8 is in the Org file, and every quiz has become a flashcard.

## The daily loop

```bash
zellij attach learning   # or: zellij --session learning
omp
/lesson <the next thing you want to understand>
```

Review the generated cards in Anki when you review your other cards. Re-read old logs from Emacs — they are
ordinary Org files, so Org-roam links, tags, and search work on them.

To keep logging into a lesson you started earlier, open it with `/org-log <file>`; to stop writing into a log,
`/org-unlog`.

## Commands

| Command | What it does |
|---|---|
| `/lesson-setup` | create a learning workspace and its config |
| `/lesson <goal>` | create today's Org log, open it in Emacs, start teaching toward that goal |
| `/lesson-context <absolute file>` | grant read access to exactly one file outside the learning directory, for this session |
| `/org-log [file]` | reopen and replay the current log, or attach an existing learning `.org` file |
| `/org-unlog` | stop logging (the file is left alone) |
| `/subagent-done [summary]` | *inside a child pane:* finish that agent and return a summary to the teacher |

Tools the teacher uses on its own: `quiz`, `subagent`, `subagents_list`, `subagent_interrupt`, `subagent_resume`,
and the diagram tools.

## What it may and may not read

By default the teacher can read your **learning directory and nothing else**. It will not wander into the rest of
your Org-roam notes, and it cannot read your Anki file — that one is write-only, so old cards never become
"evidence" about what you know. Memory tools are disabled during a lesson for the same reason: what it believes
about your knowledge should come from what you actually answered.

If a lesson needs an outside file — a paper, a codebase, a note that lives elsewhere — hand it over explicitly:

```
/lesson-context /Users/you/papers/tls13.pdf
```

That grants exactly that one file, for that session.

Inside logs, there is a further distinction it is told to respect: teacher prose is reference material, and only
*your* answers and attempts count as evidence of what you understand.

## Anki cards

Every `quiz` call carries a second payload the popup never shows you: a self-contained question and a plain-text
answer, written to stand alone months later. After you answer, that pair is appended to your Anki file as a
`Basic` note under your configured heading, tagged `:omp_learning:`, with a link back to the lesson log:

```org
** Why does a TLS handshake need a signature at all?  :omp_learning:
:PROPERTIES:
:ANKI_NOTE_TYPE: Basic
:ANKI_DECK: Learning
:END:
*** Front
Why does a TLS handshake need a signature at all?
*** Back
Key exchange alone gives you a shared secret with *someone* …

[[file:learning/2026-09-05-tls.org][Learning log]]
```

Push them with `anki-editor-push-notes` (or `org-anki-sync-all`) when you next sync. Nothing in this package
talks to Anki directly, and it never edits or reads notes it did not write.

## Making it yours

The teaching philosophy is a plain Markdown file: `skills/teach/SKILL.md`. It is written for one specific
learner, and you should edit it — how you like to be taught, what you already know, what "too easy" means for
you. The two principles it is built on (start from foundations you accept at face value; make every step feel
discoverable rather than decreed) come from the original author's system.

Other things worth editing:

- `skills/visualize/SKILL.md` — when a picture is worth making.
- `agents/researcher.md`, `agents/mermaid-maker.md`, `agents/svg-maker.md` — the child agents.
- Drop your own agent definitions in `<learningDir>/.omp/agents/*.md` — those win over the bundled ones, so you
  can override the researcher without touching the package.

## Troubleshooting

**"Emacs lesson integration failed."** The Emacs server is not running, or a buffer for the log file has unsaved
changes that conflict with what is on disk. Run `emacsclient --eval t`; save or revert the buffer; retry with
`/org-log`.

**"No supported multiplexer is available."** You started OMP outside Zellij. Exit, run `zellij --session
learning`, start `omp` inside it. Child agents deliberately fail loudly here rather than silently degrading into
invisible background jobs.

**"Start a logged lesson with /lesson `<goal>` before asking a quiz."** Quizzes only exist inside a logged
session, so no graded answer is ever lost. Run `/lesson`.

**"Diagram verification requires a vision-capable model."** The maker has to look at its own PNG. Select a model
that accepts images.

**"Outside the shared learning directory."** Working as intended — see [above](#what-it-may-and-may-not-read).
Use `/lesson-context <file>` if you meant to share that file.

**A child pane is stuck.** Focus it and press `Esc` (or ask the teacher to interrupt it). The child stays open
and resumable; its transcript is kept under `<learningDir>/.omp-learn/subagents/`.

## Development

```bash
bun install
bun run check   # typecheck
bun run test    # Bun tests + Emacs ERT regressions
```
