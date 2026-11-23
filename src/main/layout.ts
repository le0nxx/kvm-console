import type { Rect } from './types';

export interface GridSpec {
  cols: number;
  rows: number;
  gap: number;
  inset: number;
}

export const DEFAULT_GRID: GridSpec = { cols: 3, rows: 3, gap: 8, inset: 2 };

/**
 * Split an area into cols*rows tiles. Every tile is inset so the shell can
 * paint a 2px state border underneath the WebContentsView.
 */
export function gridRects(area: Rect, spec: GridSpec = DEFAULT_GRID): Rect[] {
  const { cols, rows, gap, inset } = spec;
  if (cols < 1 || rows < 1) return [];
  const cw = (area.width - gap * (cols - 1)) / cols;
  const ch = (area.height - gap * (rows - 1)) / rows;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round(area.x + c * (cw + gap));
      const x1 = Math.round(area.x + c * (cw + gap) + cw);
      const y0 = Math.round(area.y + r * (ch + gap));
      const y1 = Math.round(area.y + r * (ch + gap) + ch);
      out.push({
        x: x0 + inset,
        y: y0 + inset,
        width: Math.max(1, x1 - x0 - inset * 2),
        height: Math.max(1, y1 - y0 - inset * 2),
      });
    }
  }
  return out;
}

/** Keep a rect inside the window content area. */
export function clampRect(rect: Rect, area: Rect): Rect {
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, area.x + area.width - x)),
    height: Math.max(1, Math.min(rect.height, area.y + area.height - y)),
  };
}
