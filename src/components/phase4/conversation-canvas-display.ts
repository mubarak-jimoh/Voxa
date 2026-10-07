import { ConversationCanvas, ConversationCanvasSection } from '../../types/phase4-intelligence';

/** Collapsed workspace shows header/summary only — no reserved section height. */
export function canvasSectionsForDisplay(
  canvas: ConversationCanvas,
  expanded: boolean,
): ConversationCanvasSection[] {
  if (!expanded) return [];
  return canvas.sections;
}

export function canvasChevronName(expanded: boolean): 'chevron-up' | 'chevron-down' {
  return expanded ? 'chevron-up' : 'chevron-down';
}
