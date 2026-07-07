# AGENTS.md

Guidance for AI coding agents working in this repository. Read this file first,
then follow the links below — this file is a map, not a rulebook. Definitions
live in exactly one place each; this file never restates them.

## Project Overview

Procedural fantasy diorama generator: a browser SPA (Vite + TypeScript +
three.js) that generates a miniature fantasy settlement from a seed and six
parameters. Generation is strictly deterministic: the same seed and parameters
must always produce an identical world. This is a docs-first repository — the
documents under `docs/internal/` are the source of truth and code follows them,
never the other way around.

## Commands

Node version: see `.nvmrc`.

```sh
npm run dev        # dev server (Vite)
npm test           # vitest run (includes determinism hash snapshots)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run build      # production build
npm run preview    # serve the build
```

Run `npm test`, `npm run typecheck`, and `npm run lint` before every commit.
All three must pass; the app must also still start with `npm run dev`.

## Documentation Map

All internal documents are written in Japanese. Read them as-is; do not
translate or rewrite them.

| Document | Canonical for |
|---|---|
| `docs/internal/specs/design.md` | What the app is: UX principles, the six parameters, user-visible prohibitions |
| `docs/internal/specs/art-direction.md` | How it looks: every color, light, fog, camera, and UI token value |
| `docs/internal/specs/implementation-spec.md` | How it is built and verified: phases, derived variables, checks, performance discipline |
| `docs/internal/contracts/README.md` | Index of data contracts (WorldModel schema, split by domain) |
| `docs/internal/contracts/pipeline.md` | RNG API, module boundary rules, pipeline stage contracts, hash definition, render presets |
| `docs/internal/workflow.md` | Living process norms: review criteria, rejection rules, agent model selection, commit rules |
| `docs/internal/plans/` | Historical records of completed work. FROZEN — never edit |
| `docs/user/README.md` | End-user guide |

When a task touches a value or rule, find its canonical document above and read
that section before changing anything.

## Repository Layout

| Path | Role |
|---|---|
| `src/rng/` | Deterministic RNG (three.js-free) |
| `src/pipeline/` | Generation stages, pure functions (three.js-free) |
| `src/model/` | WorldModel types and shared pure geometry/schema helpers (three.js-free) |
| `src/mesh/` | WorldModel → three.js scene graph |
| `src/viewer/` | Camera, lighting, sky, time-based effects, render presets |
| `src/ui/` | Panel, sliders, indicator, summary |
| `test/` | Vitest suites, including hash snapshot tests |

Boundary rules between these modules are defined in
`docs/internal/contracts/pipeline.md` ("モジュール境界規則"); ESLint enforces
the three.js import ban mechanically.

## Core Invariants

Violating any of these breaks determinism or the art discipline, which are the
product. Each rule is defined at the linked location — read it before acting.

- **Docs before code.** If code must deviate from a spec or contract, update
  the document first, in the same commit. See `docs/internal/workflow.md`.
- **No `Math.random()`, anywhere.** All randomness goes through named RNG
  substreams so unrelated features never share random state. See
  `contracts/pipeline.md` ("RNG API").
- **Module boundaries are hard.** `rng/`, `model/`, and `pipeline/` never
  import three.js; `mesh/` reads only the WorldModel. See
  `contracts/pipeline.md` ("モジュール境界規則").
- **WorldModel is plain serializable data.** No time, no display state, no
  renderer-dependent values. See `contracts/worldmodel-core.md`.
- **Hash snapshot tests stay green.** If a generation change is intentional,
  update the snapshots in the same commit and explain the intent in the commit
  message. See `contracts/pipeline.md` ("WorldModel 正規化ハッシュ").
- **Visual numbers live in `specs/art-direction.md`.** Never tune a color,
  light, or fog value in code without updating that document first.
- **No placeholders.** Unimplemented scope belongs to a future phase by
  design; half-done stand-ins inside the current scope are not allowed.

## Workflow

Implementation is delegated to subagents; a lead session reviews every diff
before committing. The review criteria (six points), rejection rules, and
agent model selection policy are defined in `docs/internal/workflow.md` —
follow them rather than improvising.

## Commit & PR Guidelines

- Message format: `phaseN: summary` for generation/rendering work, `docs:` or
  `chore:` otherwise. Japanese messages are the norm.
- One commit is one reviewable unit; doc updates precede code within it.
- Never modify `docs/internal/plans/` — it is frozen history. Current norms
  live in `docs/internal/workflow.md`.

## Claude Code Setup

Claude Code auto-loads `CLAUDE.md`. To reuse this file without duplicating it,
create a local symlink once (it is gitignored):

```sh
ln -s AGENTS.md CLAUDE.md
```
