import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  isTalkListNearBottom,
  nextTalkJumpToLatestVisible,
  shouldPinTalkToLatest,
} from '../src/services/chat/talk-list-pin';

describe('Talk jump-to-latest', () => {
  it('keeps reading position when a reply arrives off the bottom', () => {
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'reply' }), false);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'typing' }), false);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: false, reason: 'reply' }), true);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: false, reason: 'typing' }), true);
  });

  it('uses hysteresis so the button is not shown at the bottom edge', () => {
    const bottom = { contentOffsetY: 904, contentHeight: 1000, layoutHeight: 100 };
    assert.equal(isTalkListNearBottom(bottom), true);
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: true, ...bottom }), false);

    const mid = { contentOffsetY: 780, contentHeight: 1000, layoutHeight: 100 };
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: false, ...mid }), false);
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: true, ...mid }), true);

    const far = { contentOffsetY: 400, contentHeight: 2000, layoutHeight: 400 };
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: false, ...far }), true);
  });

  it('wires a compact overlay above the composer, not over the tab bar', () => {
    const screen = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(screen, /<TalkJumpToLatestButton/);
    assert.match(screen, /jumpToLatest/);
    assert.match(screen, /styles\.listWrap/);
    const buttonIndex = screen.indexOf('<TalkJumpToLatestButton');
    const composerIndex = screen.indexOf('<ChatInputBar');
    assert.ok(buttonIndex > 0 && composerIndex > buttonIndex);
    const button = readFileSync('src/components/chat/talk-jump-to-latest.tsx', 'utf8');
    assert.match(button, /chevron-down/);
    assert.match(button, /Scroll to latest message/);
    assert.doesNotMatch(button, /tabBarHeight/);
  });
});
