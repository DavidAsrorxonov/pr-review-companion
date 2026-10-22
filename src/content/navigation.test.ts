import { describe, expect, it, vi } from 'vitest';
import { createRouteCoordinator } from './navigation';

describe('navigation coordinator', () => {
  it('cancels DOM jumps on same-PR URL changes without remounting or fetching', () => {
    let url = 'https://github.com/owner/repo/pull/1';
    const mounted = { restore: vi.fn(), destroy: vi.fn(), revalidate: vi.fn(), suspend: vi.fn(), navigated: vi.fn() };
    const mount = vi.fn().mockReturnValue(mounted);
    const coordinator = createRouteCoordinator(() => url, mount); coordinator.sync(); coordinator.sync();
    expect(mounted.navigated).not.toHaveBeenCalled();
    url += '/files'; coordinator.sync(); url += '#discussion_r1'; coordinator.sync();
    expect(mounted.navigated).toHaveBeenCalledTimes(2); expect(mount).toHaveBeenCalledOnce();
    expect(mounted.revalidate).not.toHaveBeenCalled();
  });
  it('mounts once on PR entry, preserves subpage state, and tears down on departure', () => {
    let url = 'https://github.com/owner/repo';
    const mounted = { restore: vi.fn(), destroy: vi.fn(), revalidate: vi.fn(), suspend: vi.fn() };
    const mount = vi.fn().mockReturnValue(mounted);
    const coordinator = createRouteCoordinator(() => url, mount);
    coordinator.sync(); expect(mount).not.toHaveBeenCalled();
    url += '/pull/1'; coordinator.sync(); coordinator.sync();
    expect(mount).toHaveBeenCalledOnce();
    const isCurrent = mount.mock.calls[0]![1] as () => boolean;
    url += '/files#discussion'; coordinator.sync(); expect(mount).toHaveBeenCalledOnce(); expect(isCurrent()).toBe(true);
    url = 'https://github.com/owner/repo/pull/2'; coordinator.sync();
    expect(mount).toHaveBeenCalledTimes(2); expect(mounted.destroy).toHaveBeenCalledOnce(); expect(isCurrent()).toBe(false);
    url = 'https://github.com/owner/repo'; coordinator.sync(); expect(mounted.destroy).toHaveBeenCalledTimes(2);
  });
  it('invalidates old callbacks even when returning to the same PR and supports restoration', () => {
    let url = 'https://github.com/owner/repo/pull/1';
    const mounted = { restore: vi.fn(), destroy: vi.fn(), revalidate: vi.fn(), suspend: vi.fn() };
    const mount = vi.fn().mockReturnValue(mounted);
    const coordinator = createRouteCoordinator(() => url, mount); coordinator.sync();
    const first = mount.mock.calls[0]![1] as () => boolean;
    coordinator.suspend(); coordinator.revalidate(); coordinator.sync();
    expect(mounted.suspend).toHaveBeenCalledOnce(); expect(mounted.restore).toHaveBeenCalledTimes(2);
    url = 'https://github.com/owner/repo/pull/2'; coordinator.sync();
    url = 'https://github.com/owner/repo/pull/1'; coordinator.sync(); expect(first()).toBe(false);
    coordinator.destroy(); expect(mounted.destroy).toHaveBeenCalledTimes(3);
  });
});
