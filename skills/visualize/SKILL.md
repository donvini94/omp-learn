---
name: visualize
description: "Add a correct, minimal visual to a lesson — a diagram or geometric picture — that renders inline in the Emacs Org learning log. Use when an idea is genuinely clearer as a picture: a dependency graph, system/flow, sequence, state machine, tree, comparison, or a spatial/geometric thing (coordinate geometry, number line, vectors, a plot, a physical layout). Outsources authoring+rendering to a maker subagent that verifies the image by looking at it, then you embed the returned file."
---

# Visualize

A picture earns its place only when it shows something words can't — shape, structure, direction, relationship, geometry. This skill produces ONE such picture, guarantees it is **correct** (the maker renders it and looks at it before returning), and drops it into the lesson so it renders inline in the Emacs Org learning log.

You are the **creative director**. You decide the exact idea and distill it to its fewest carrying elements. A **maker subagent** does the authoring, rendering, visual verification, and saving, then returns its absolute path. You embed that path in your reply.

## When to visualize (and when not to)

This teaching system builds a **dependency graph in the learner's head** — foundations at the root, derived facts hanging off them. A visual is powerful exactly when it makes that structure (or a geometry) visible. Reach for one when:

- The idea is a **structure or relationship**: dependencies, a system with parts and arrows, a flow/pipeline, a sequence of exchanges, a state machine, a tree/hierarchy, a comparison, a containment (what's inside vs outside).
- The idea is **spatial or geometric**: coordinate geometry, a number line, vectors, a function's shape, a physical arrangement.

Do NOT visualize when prose or a single equation already carries it. A decorative diagram that just restates the sentence next to it adds noise and a chance to be wrong. When in doubt, don't — a missing visual is cheaper than a false one.

## Choose the maker

Two makers, discovered from the project's `agents/` directory:

- **`mermaid-maker`** — structural/relational visuals: dependency graphs, flowcharts, sequence/state/ER/class diagrams, trees, mindmaps, timelines. This is the default and fits the dependency-graph pedagogy directly.
- **`svg-maker`** — spatial/geometric visuals Mermaid can't lay out: exact coordinates, geometry figures, number lines, vectors, plots, custom shapes.

Rule of thumb: if it's *nodes-and-edges / relationships*, use mermaid-maker. If it's *positions-and-shapes / geometry*, use svg-maker.

## Brief the maker well: one idea, fewest elements

The most common failure is **cramming** — every extra label makes the picture harder to read AND harder to lay out correctly. Before briefing, prune to the fewest elements that carry the idea, and for each ask: *"if I delete this, is the idea still clear?"* If yes, delete it.

Give the maker the concept AND the concrete elements you want — not a vague topic, and not a long checklist.

- BAD: "make a diagram about how TCP works"
- GOOD: "graph TD: a node 'packet' at the top; arrows down to 'ordering' and 'retransmit on loss'; both arrows down into 'reliable stream'. No title. Show that reliability is built FROM packets, not alongside them."

Keep the idea intact but trust the maker to compose; if your brief lists more than ~5–7 elements, cut it first.

## Invoke

Dispatch the maker with `subagent`. It opens a real OMP session in its own multiplexer pane, so you can watch it work and it never blocks this conversation:

```
subagent({ name: "Diagram: <topic>", agent: "mermaid-maker", task: "<your minimal, concrete brief>" })
```
```
subagent({ name: "Figure: <topic>", agent: "svg-maker", task: "<your minimal, concrete brief>" })
```

The call returns immediately; the maker's result arrives later as a message carrying its summary and session path. Include the lesson orientation the maker needs inside `task` — it starts with no knowledge of this conversation.

The maker owns its own purpose-built tools (`write_*`/`edit_*`/`render_*`) — it authors the source, renders it to a PNG, **looks at the PNG and iterates until it is correct and clean**, publishes it into the learning directory's `viz` folder with a unique filename, and returns:

```
RESULT:
filename: viz-<slug>-<timestamp>.png
path: <cwd>/viz/viz-<slug>-<timestamp>.png
```

If it returns `RESULT: NONE`, it couldn't make a correct picture of the brief — simplify or rethink, or decide the visual isn't worth it. Never hand-author or fake a diagram yourself; correctness depends on the maker's render-and-inspect loop.

If no multiplexer is available, `subagent` fails explicitly rather than falling back. Start OMP inside Zellij (`zellij --session learning`), or render and inspect the picture inline yourself through the same render tools — you must still actually look at the rendered image before presenting it. Skipping that verification step is never acceptable.

## Embed it in the lesson

Put the embed directly in your teaching reply, using an ordinary Markdown image link to the returned **absolute path** (not just the filename):

```
![<short alt text>](/absolute/path/to/viz-<slug>-<timestamp>.png)
```

That's all. The Emacs Org log conversion turns that Markdown image link into an Org-mode image link automatically, so it renders inline in the lesson log without any extra step from you. Introduce the visual in a sentence, then let it carry the idea — don't narrate every element back in prose.

## Why this is reliable

- The maker never returns a picture it hasn't **looked at**, so "renders fine but says something false" is caught before it reaches the learner.
- PNG embed means **what the maker verified is pixel-identical to what the learner sees** — no re-render drift.
- Unique filenames plus absolute paths keep every embed pointing at exactly the PNG it was verified against — no ambiguity across lessons.

> The makers render through the project's `visual-tools` extension (Mermaid via a bundled `@mermaid-js/mermaid-cli` + installed Chrome; SVG via `rsvg-convert`, fallback ImageMagick). You don't render anything yourself — you only brief the maker and embed the absolute path it returns.
