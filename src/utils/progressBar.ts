/**
 * Block-fill progress bar string builder, shared by the self-update progress
 * bar (components/PromptInput/SourceUpdateProgress.tsx) and the compaction
 * spinner's progress bar (components/Spinner/SpinnerAnimationRow.tsx) so both
 * render with the same fill convention.
 */

const FILLED = '█'
const EMPTY = '░'

/**
 * Renders a `width`-cell bar for `percent` (0-100, clamped), filled left to
 * right. Pure string builder — no color, no animation; callers wrap the
 * result in their own `Text` as needed.
 */
export function renderProgressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  return FILLED.repeat(filled) + EMPTY.repeat(width - filled)
}
