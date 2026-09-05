/**
 * visual-tools
 *
 * A self-contained pi extension that registers custom subagent tools directly
 * on the host `pi` — and does nothing else:
 *
 *   • write_mermaid / edit_mermaid / render_mermaid
 *       (tools/mermaid_tools.ts) — the mermaid-maker's authoring loop: write a
 *       Mermaid source, exact-match edit it, render whatever is currently in
 *       the managed file to a PNG (via the root project's bundled
 *       @mermaid-js/mermaid-cli and an installed Chrome), return the PNG
 *       inline for inspection, and — when given `save_as` — publish it into
 *       <learningDir>/viz with a unique name.
 *   • write_svg / edit_svg / render_svg
 *       (tools/svg_tools.ts) — the svg-maker's authoring loop: same shape, but
 *       renders hand-written SVG to a PNG via rsvg-convert (fallback: magick).
 *
 * Both trios are registered directly by calling their existing default
 * exports with the host `pi` and the resolved `LearnConfig`, so output always
 * lands under `config.learningDir/viz` and rendering honors
 * `config.browserExecutable` when set. There is no global registry, no
 * interactive-subagents indirection, and no personal/author-local paths.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import type { LearnConfig } from "../../src/config.ts"
import mermaidToolsExtension from "./tools/mermaid_tools.ts"
import svgToolsExtension from "./tools/svg_tools.ts"

export default function visualTools(pi: ExtensionAPI, config: LearnConfig) {
  mermaidToolsExtension(pi, config)
  svgToolsExtension(pi, config)
}
