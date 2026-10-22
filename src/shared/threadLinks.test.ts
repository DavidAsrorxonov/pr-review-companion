import { describe, expect, it } from 'vitest';
import { discussionLinks } from './threadLinks';

const pr = { owner: 'owner', repo: 'repo', number: 12 };
const base = 'https://github.com/owner/repo/pull/12';
describe('discussion permalinks', () => {
  it('preserves published comment order, normalizes identity, and deduplicates anchors', () => {
    const urls = [`${base}#discussion_r23`, `${base}/files#discussion_r24`, `${base}#discussion_r23`];
    expect(discussionLinks(urls.map(url => ({ url })), pr)).toEqual([
      { url: urls[0], fragment: 'discussion_r23' }, { url: urls[1], fragment: 'discussion_r24' },
    ]);
    expect(discussionLinks([{ url: base.replace('owner/repo', 'OWNER/REPO') + '#discussion_r1' }], pr)).toHaveLength(1);
  });
  it.each([
    'http://github.com/owner/repo/pull/12#discussion_r1',
    'https://evil.test/owner/repo/pull/12#discussion_r1',
    'https://github.com.evil.test/owner/repo/pull/12#discussion_r1',
    'https://user:secret@github.com/owner/repo/pull/12#discussion_r1',
    'https://github.com:444/owner/repo/pull/12#discussion_r1',
    `${base}3#discussion_r1`, base.replace('/repo/', '/another/') + '#discussion_r1',
    `${base}#issuecomment-1`, `${base}#discussion_r1-permalink`, `${base}#discussion_r0`,
    `${base}#discussion_r-1`, `${base}#discussion_r1%20`, `${base}/files/commit#discussion_r1`,
    'javascript:alert(1)', '//github.com/owner/repo/pull/12#discussion_r1', `${base}#`,
  ])('rejects unsafe, cross-PR, or unsupported link %s', url => {
    expect(discussionLinks([{ url }], pr)).toEqual([]);
  });
  it('needs no node IDs, author, source position, or thread state', () => {
    expect(discussionLinks([{ url: `${base}#discussion_r123` }], pr)).toHaveLength(1);
    expect(discussionLinks([], pr)).toEqual([]);
  });
});
