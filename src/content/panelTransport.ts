import { requestPanel } from '../shared/panel';
import { requestReviews } from '../shared/reviews';
import type { PanelTransport } from '../panel/session';

// Shared by all PR sessions in this isolated document. Never let an old cancel
// overtake the next load when navigating or rapidly closing/reopening the drawer.
let cancellation: Promise<unknown> = Promise.resolve();
export const panelTransport: PanelTransport = {
  panel: requestPanel,
  async reviews(request) { if (request.type === 'reviews.load') await cancellation; return requestReviews(request); },
  cancel(jobId) {
    cancellation = cancellation.then(() => requestReviews({ type: 'reviews.cancel', jobId })).catch(() => undefined);
    return cancellation;
  },
};
