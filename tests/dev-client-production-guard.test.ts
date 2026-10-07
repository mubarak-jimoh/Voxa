import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('production debug control guard', () => {
  it('does not ship a custom floating gear in app source', () => {
    const app = readFileSync('App.tsx', 'utf8');
    assert.doesNotMatch(app, /floating/i);
    assert.doesNotMatch(app, /DevMenu/);
    assert.doesNotMatch(app, /name=["']cog/);
    assert.doesNotMatch(app, /name=["']settings/);

    const eas = JSON.parse(readFileSync('eas.json', 'utf8')) as {
      build?: Record<string, { developmentClient?: boolean }>;
    };
    assert.notEqual(eas.build?.preview?.developmentClient, true);
    assert.notEqual(eas.build?.production?.developmentClient, true);
    assert.equal(eas.build?.development?.developmentClient, true);

    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    assert.ok(pkg.dependencies?.['expo-dev-client']);
  });
});
