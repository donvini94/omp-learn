# Provenance and licensing

This package is a port of a third-party project. Three different origins are mixed here, and they do not share
one licence.

## 1. Derived from `amosblomqvist/learn`

<https://github.com/amosblomqvist/learn> — the original pi-based learning system, by Amos Blomqvist / Eero Alvar.

Files in this repository that started there and were modified:

- `skills/teach/SKILL.md`, `skills/visualize/SKILL.md`
- `extensions/quiz.ts`
- `extensions/visual-tools/**`
- `agents/researcher.md`, `agents/mermaid-maker.md`, `agents/svg-maker.md`

Files deleted from the upstream set during the port: `extensions/ask-user-question.ts` (replaced by OMP's native
`ask` tool) and `extensions/md-log.ts` (replaced by the Org logger in `src/notebook.ts`).

**That repository publishes no LICENSE file**, so no redistribution rights have been granted in writing. This
port is published anyway, publicly and with attribution, on the understanding that the original was shared
publicly as a system for others to adopt. If Amos Blomqvist objects, this repository comes down or the derived
files are removed on request — open an issue or contact the maintainer.

If you are reading this because you want to reuse the derived files yourself: ask upstream first. The MIT grant
in [LICENSE](LICENSE) covers only the original work in section 3.


## 2. Depends on `HazAT/pi-interactive-subagents`

<https://github.com/HazAT/pi-interactive-subagents> — MIT licensed. Used as an ordinary dependency, pinned to
`v3.7.2` (`c100577ebf7393a11d098ad9810ec6c269dcfc30`); its multiplexer backend drives the Zellij panes. No source
from it is copied into this repository.

## 3. Original work in this repository

Everything under `src/`, `emacs/`, `test/`, this file, and the README is original to this port and is offered by
its author under the MIT terms in [LICENSE](LICENSE). That grant covers only these files — it cannot and does not
relicense the derived files in section 1.
