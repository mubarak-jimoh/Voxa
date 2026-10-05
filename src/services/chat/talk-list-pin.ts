const NEAR_BOTTOM_PX = 96;

export function isTalkListNearBottom(input: {
  contentOffsetY: number;
  contentHeight: number;
  layoutHeight: number;
}): boolean {
  const maxOffset = Math.max(0, input.contentHeight - input.layoutHeight);
  return maxOffset - input.contentOffsetY <= NEAR_BOTTOM_PX;
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
