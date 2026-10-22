// Dependency-free URL parsing keeps the GitHub-wide navigation bootstrap small.
export type PrIdentity = { owner: string; repo: string; number: number };
export function parsePrUrl(value: string): PrIdentity | null {
  try {
    const url = new URL(value.trim());
    if (url.origin !== 'https://github.com' || url.username || url.password || /[%\\]/.test(value)) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(url.pathname);
    if (!match) return null;
    const [, owner = '', repo = '', rawNumber = ''] = match;
    const number = Number(rawNumber);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo)
      || repo === '.' || repo === '..' || !Number.isSafeInteger(number) || number > 2_147_483_647) return null;
    return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number };
  } catch { return null; }
}
