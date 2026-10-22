import { parsePrUrl, type PrIdentity } from "./prUrl";

export type DiscussionLink = { url: string; fragment: string };
// Node IDs and source positions are deliberately not inputs to anchor resolution.
export function discussionLinks(
  comments: readonly { url: string }[],
  pr: PrIdentity,
): DiscussionLink[] {
  const links: DiscussionLink[] = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    try {
      const url = new URL(comment.url);
      const identity = parsePrUrl(comment.url);
      if (
        !identity ||
        identity.owner !== pr.owner ||
        identity.repo !== pr.repo ||
        identity.number !== pr.number ||
        !/^#discussion_r[1-9]\d*$/.test(url.hash)
      )
        continue;
      if (!seen.has(url.hash)) {
        seen.add(url.hash);
        links.push({ url: url.href, fragment: url.hash.slice(1) });
      }
    } catch {
      /* Unusable permalinks are never offered as navigation targets. */
    }
  }
  return links;
}
