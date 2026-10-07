const NEAR_BOTTOM_PX = 96;
const JUMP_TO_LATEST_SHOW_PX = 180;

export function talkListDistanceFromBottom(input: {
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}): number {
  const maxOffset = Math.max(0, input.contentHeight - input.layoutHeight);
  return Math.max(0, maxOffset - input.contentOffsetY);
}

export function isTalkListNearBottom(input: {
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}): boolean {
  return talkListDistanceFromBottom(input) <= NEAR_BOTTOM_PX;
}

/** Hysteresis so the jump control does not flicker around the near-bottom edge. */
export function nextTalkJumpToLatestVisible(input: {
  currentlyVisible: boolean;
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}): boolean {
  const distance = talkListDistanceFromBottom(input);
  if (distance > JUMP_TO_LATEST_SHOW_PX) return true;
  if (distance <= NEAR_BOTTOM_PX) return false;
  return input.currentlyVisible;
}

export function shouldPinTalkToLatest(input: {
  userReadingHistory: boolean;
  reason: 'load' | 'send' | 'reply' | 'typing' | 'foreground';
}): boolean {
  if (input.reason === 'load' || input.reason === 'send' || input.reason === 'foreground') {
    return true;
  }
  if (input.userReadingHistory) return false;
  return input.reason === 'reply' || input.reason === 'typing';
}
