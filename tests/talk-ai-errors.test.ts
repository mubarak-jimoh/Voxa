import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TalkAIError,
  classifyGatewayErrorMessage,
  formatTalkErrorForUser,
  isGatewayDeploymentError,
} from '../src/services/ai/talk-ai-errors';

describe('talk AI errors', () => {
  it('classifies undeployed Supabase edge functions', () => {
    assert.equal(
      classifyGatewayErrorMessage('Requested function was not found'),
      'gateway_not_deployed',
    );
    assert.equal(
      classifyGatewayErrorMessage('Failed to send a request to the Edge Function'),
      'gateway_not_deployed',
    );
  });

  it('maps server-side gateway codes to user-safe categories', () => {
    assert.equal(classifyGatewayErrorMessage('x', 'provider_not_configured'), 'provider_not_configured');
    assert.equal(classifyGatewayErrorMessage('x', 'database_error'), 'database_error');
    assert.equal(classifyGatewayErrorMessage('x', 'invalid_session'), 'invalid_session');
    assert.equal(classifyGatewayErrorMessage('x', 'provider_error'), 'provider_error');
    assert.equal(classifyGatewayErrorMessage('x', 'daily_limit'), 'usage_limited');
    assert.equal(classifyGatewayErrorMessage('x', 'fair_use_exceeded'), 'usage_limited');
    assert.equal(classifyGatewayErrorMessage('Request timed out after 45000ms'), 'request_timeout');
  });

  it('maps deployment errors to calm user copy', () => {
    const err = new TalkAIError('gateway_not_deployed');
    assert.equal(err.isDeploymentBlocker, true);
    assert.equal(formatTalkErrorForUser(err), err.userMessage);
    assert.ok(!formatTalkErrorForUser(err).includes('Requested function'));
  });

  it('maps server-side size guard codes', () => {
    assert.equal(classifyGatewayErrorMessage('x', 'message_too_large'), 'message_too_large');
    assert.equal(classifyGatewayErrorMessage('x', 'context_too_large'), 'context_too_large');
    assert.equal(
      classifyGatewayErrorMessage('Message exceeds maximum size.'),
      'message_too_large',
    );
    assert.equal(
      classifyGatewayErrorMessage('Conversation context exceeds maximum size.'),
      'context_too_large',
    );
  });

  it('detects gateway deployment errors for dev fallback', () => {
    assert.equal(isGatewayDeploymentError(new TalkAIError('gateway_not_deployed')), true);
    assert.equal(isGatewayDeploymentError(new TalkAIError('provider_not_configured')), false);
  });

  it('formats unknown errors safely', () => {
    assert.equal(
      formatTalkErrorForUser(new Error('Requested function was not found')),
      new TalkAIError('gateway_not_deployed').userMessage,
    );
    assert.equal(
      formatTalkErrorForUser(new Error('Edge Function returned a non-2xx status code')),
      "Voxa couldn't send that message. Please try again.",
    );
    assert.equal(
      formatTalkErrorForUser(new TalkAIError('provider_not_configured')),
      new TalkAIError('provider_not_configured').userMessage,
    );
  });
});
