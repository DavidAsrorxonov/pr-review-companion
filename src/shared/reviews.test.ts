import { describe, expect, it } from 'vitest';
import { parsePrUrl } from './reviews';

describe('PR URL validation', () => {
  it.each(['', 'https://evil.test/a/b/pull/1', 'http://github.com/a/b/pull/1', 'https://x@github.com/a/b/pull/1',
    'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/9999999999999999999999',
    'https://github.com/a/b/pull/1/unknown', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/1/files/nested',
    'https://github.com:8443/a/b/pull/1', 'https://github.com/a%2Fb/c/pull/1', 'https://github.com/a/b/pull/-1',
    'https://github.com/a/b/pull/1.5', 'https://github.com/a/b/pull/01'])('rejects %s', value => {
    expect(parsePrUrl(value)).toBeNull();
  });
  it.each(['', '/', '/files', '/commits', '/checks', '/files?diff=split#discussion_r123'])('normalizes PR URLs %s', suffix => {
    expect(parsePrUrl(` https://github.com/Octocat/Hello-World/pull/123${suffix} `)).toEqual({ owner: 'octocat', repo: 'hello-world', number: 123 });
  });
});
