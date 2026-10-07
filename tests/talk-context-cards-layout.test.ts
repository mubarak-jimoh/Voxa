import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('Talk context cards stay compact', () => {
  it('does not use a stretching ScrollView for context or memory chips', () => {
    const cards = readFileSync('src/components/phase4/context-cards-row.tsx', 'utf8');
    const chips = readFileSync('src/components/phase7/chat-context-chips.tsx', 'utf8');
    assert.doesNotMatch(cards, /ScrollView/);
    assert.doesNotMatch(chips, /ScrollView/);
    assert.match(cards, /flexWrap: 'wrap'/);
    assert.match(chips, /flexWrap: 'wrap'/);
    assert.match(cards, /flexGrow: 0/);
    assert.match(chips, /flexGrow: 0/);
    assert.doesNotMatch(cards, /minHeight/);
    assert.doesNotMatch(chips, /minHeight/);
    assert.doesNotMatch(cards, /flex:\s*1/);
    assert.doesNotMatch(chips, /flex:\s*1/);
    assert.match(cards, /numberOfLines=\{1\}/);
    assert.match(chips, /numberOfLines=\{1\}/);
    assert.match(cards, /Today's journal|card\.label/);
  });

  it('keeps the Talk strip from growing into the conversation list', () => {
    const screen = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(screen, /styles\.contextStrip/);
    assert.match(screen, /contextStrip: \{[\s\S]*flexGrow: 0/);
    assert.match(screen, /TalkJumpToLatestButton/);
    assert.match(screen, /<ContextCardsRow/);
  });
});
