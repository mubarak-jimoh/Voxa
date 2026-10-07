import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyOpenAiLiveHttpFailure,
  countryFromTimeZone,
  formatSourceLine,
  parseResponsesLiveResult,
  sanitizeSourceTitle,
  toResponsesLivePayload,
} from '../supabase/functions/_shared/openai-live-search.ts';

describe('openai live search payload', () => {
  it('converts chat messages to Responses instructions + input', () => {
    const payload = toResponsesLivePayload([
      { role: 'system', content: 'You are Voxa.' },
      { role: 'user', content: "Who's top of the Premier League?" },
    ]);
    assert.match(payload.instructions, /You are Voxa/);
    assert.equal(payload.input.length, 1);
    assert.equal(payload.input[0]?.role, 'user');
    assert.equal(payload.input[0]?.content, "Who's top of the Premier League?");
  });

  it('parses successful search text and source titles without raw URLs', () => {
    const parsed = parseResponsesLiveResult({
      output_text: 'Arsenal are top.',
      output: [
        { type: 'web_search_call', status: 'completed' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Arsenal are top.',
              annotations: [
                { type: 'url_citation', title: 'Premier League', url: 'https://example.com/table' },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(parsed.usedWebSearch, true);
    assert.match(parsed.text, /Arsenal are top/);
    assert.deepEqual(parsed.sourceTitles, ['Premier League']);
    assert.equal(formatSourceLine(parsed.sourceTitles), 'Sources · Premier League');
    assert.equal(sanitizeSourceTitle('https://secret.example/path'), '');
  });

  it('treats missing search as a failure, not as a live answer', () => {
    const parsed = parseResponsesLiveResult({
      output_text: 'I think they might be first.',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'I think they might be first.' }] }],
    });
    assert.equal(parsed.usedWebSearch, false);
  });

  it('does not treat an incomplete truncated response as a live answer', () => {
    const parsed = parseResponsesLiveResult({
      status: 'incomplete',
      output: [{ type: 'web_search_call', status: 'completed' }],
    });
    assert.equal(parsed.usedWebSearch, true);
    assert.equal(parsed.text, '');
  });

  it('classifies upstream live-search HTTP failures without payloads', () => {
    assert.equal(classifyOpenAiLiveHttpFailure(400, 'unsupported_tool'), 'unsupported_tool');
    assert.equal(classifyOpenAiLiveHttpFailure(429), 'rate_limited');
    assert.equal(classifyOpenAiLiveHttpFailure(504), 'timeout');
    assert.equal(countryFromTimeZone('Europe/London'), 'GB');
  });
});
