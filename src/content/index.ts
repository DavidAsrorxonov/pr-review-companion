// This bootstrap intentionally imports no CSS and never changes the page.
// Installing it site-wide leaves room for SPA navigation handling in step 4.
const initialUrl = new URL(window.location.href);
const isPullRequest = initialUrl.origin === 'https://github.com'
  && /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*(?:\/|$)/.test(initialUrl.pathname);

if (import.meta.env.DEV) {
  console.debug('[PR Review Companion] Bootstrap:', isPullRequest ? 'PR' : 'non-PR');
}

export {};
