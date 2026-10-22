import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadJump, type JumpEnvironment } from './threadJump';

const links = [{ url: 'https://github.com/o/r/pull/1#discussion_r1', fragment: 'discussion_r1' }];
function setup() {
  let valid = true; let target: string | null = null; let notify = () => {}; let finish = () => {};
  const stopObserving = vi.fn(); const cleanupHighlight = vi.fn();
  const env: JumpEnvironment<string> = {
    valid: vi.fn(() => valid), find: vi.fn(() => target),
    observe: vi.fn(check => { notify = check; return stopObserving; }),
    collapse: vi.fn(), reveal: vi.fn((_target, _valid, done) => { finish = done; return cleanupHighlight; }),
  };
  const jump = createThreadJump(env);
  return { jump, env, stopObserving, cleanupHighlight, appear() { target = 'comment'; notify(); },
    invalidate() { valid = false; }, notify: () => notify(), finish: () => finish() };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('bounded jump lifecycle', () => {
  it('collapses only for a located discussion and leaves success announced', async () => {
    const s = setup(); s.appear();
    expect(await s.jump.jump(links, 'revision')).toEqual({ state: 'found' });
    expect(s.env.collapse).toHaveBeenCalledOnce(); expect(s.env.reveal).toHaveBeenCalledOnce();
    expect(s.env.observe).not.toHaveBeenCalled(); expect(s.jump.getSnapshot().message).toContain('Focus moved');
    s.finish(); expect(s.cleanupHighlight).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('finds delayed content and disconnects the observer before collapsing', async () => {
    const s = setup(); const pending = s.jump.jump(links, 'revision');
    expect(s.jump.getSnapshot().state).toBe('searching'); expect(s.env.collapse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); s.appear();
    expect(await pending).toEqual({ state: 'found' }); expect(s.stopObserving).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(s.env.reveal).mock.invocationCallOrder[0]).toBeGreaterThan(s.stopObserving.mock.invocationCallOrder[0]!);
  });
  it('offers the first permalink after exactly two seconds and never collapses', async () => {
    const s = setup(); const pending = s.jump.jump(links, 'revision');
    vi.advanceTimersByTime(1999); expect(s.jump.getSnapshot().state).toBe('searching');
    vi.advanceTimersByTime(1); expect(await pending).toEqual({ state: 'unavailable', url: links[0]!.url });
    expect(s.env.collapse).not.toHaveBeenCalled(); expect(s.stopObserving).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['cancel', 'dispose', 'revision', 'new jump'])('rejects pending work after %s', async action => {
    const s = setup(); const first = s.jump.jump(links, 'revision');
    if (action === 'cancel') s.jump.cancel();
    if (action === 'dispose') s.jump.dispose();
    if (action === 'revision') { s.invalidate(); s.notify(); }
    if (action === 'new jump') { void s.jump.jump(links, 'new'); s.jump.cancel(); }
    expect(await first).toEqual({ state: 'cancelled' });
    s.appear(); vi.runAllTimers(); expect(s.env.collapse).not.toHaveBeenCalled();
    expect(s.stopObserving).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses an obsolete credential before starting a DOM observer', async () => {
    const s = setup(); s.invalidate();
    expect(await s.jump.jump(links, 'revision')).toEqual({ state: 'cancelled' });
    expect(s.env.observe).not.toHaveBeenCalled(); expect(s.env.find).not.toHaveBeenCalled();
  });
  it('an old observer callback cannot cancel or complete a newer attempt', async () => {
    const s = setup(); const first = s.jump.jump(links, 'revision');
    const oldCheck = vi.mocked(s.env.observe).mock.calls[0]![0];
    const second = s.jump.jump(links, 'revision'); oldCheck();
    expect(await first).toEqual({ state: 'cancelled' }); expect(s.jump.getSnapshot().state).toBe('searching');
    s.appear(); expect(await second).toEqual({ state: 'found' });
    oldCheck(); expect(s.env.collapse).toHaveBeenCalledOnce();
  });
  it('removes an existing highlight before a repeated jump', async () => {
    const s = setup(); s.appear(); await s.jump.jump(links, 'revision');
    await s.jump.jump(links, 'revision'); expect(s.cleanupHighlight).toHaveBeenCalledOnce();
    s.jump.dispose(); expect(s.cleanupHighlight).toHaveBeenCalledTimes(2);
  });
  it('rechecks validity after lookup and after collapse before moving focus', async () => {
    const s = setup(); s.appear(); vi.mocked(s.env.collapse).mockImplementation(s.invalidate);
    expect(await s.jump.jump(links, 'revision')).toEqual({ state: 'cancelled' });
    expect(s.env.reveal).not.toHaveBeenCalled();
  });
});
