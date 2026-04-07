import { describe, it, expect } from 'bun:test';
import { InMemoryApprovalGateway } from '../../src/approval';

describe('InMemoryApprovalGateway', () => {
  // ── request + resolve happy path ──

  it('resolves a pending request with approved outcome', async () => {
    const gw = new InMemoryApprovalGateway();

    gw.subscribe((event) => {
      if (event.type === 'requested') {
        setTimeout(() => {
          gw.resolve(event.request.id, {
            outcome: 'approved',
            choice: 'approve',
            actor: 'test',
          });
        }, 10);
      }
    });

    const decision = await gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Please approve',
      timeoutMs: 5000,
    });

    expect(decision.outcome).toBe('approved');
    expect(decision.choice).toBe('approve');
    expect(decision.actor).toBe('test');
    expect(decision.approvalId).toBeDefined();
    expect(decision.decidedAt).toBeDefined();
  });

  // ── timeout auto-fire ──

  it('auto-resolves with timeout when timeoutMs expires', async () => {
    const gw = new InMemoryApprovalGateway();
    const events: string[] = [];

    gw.subscribe((event) => {
      events.push(event.type);
    });

    const decision = await gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Will timeout',
      timeoutMs: 50,
    });

    expect(decision.outcome).toBe('timeout');
    expect(decision.reason).toContain('timed out');
    expect(events).toContain('requested');
    expect(events).toContain('expired');
  });

  // ── resolve on unknown ID returns false ──

  it('returns false when resolving an unknown approval ID', () => {
    const gw = new InMemoryApprovalGateway();
    const ok = gw.resolve('nonexistent-id', {
      outcome: 'approved',
      choice: 'approve',
      actor: 'test',
    });
    expect(ok).toBe(false);
  });

  // ── double resolve returns false on second call ──

  it('returns false on double resolve (already settled)', async () => {
    const gw = new InMemoryApprovalGateway();
    let capturedId = '';

    gw.subscribe((event) => {
      if (event.type === 'requested') {
        capturedId = event.request.id;
      }
    });

    const promise = gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Double resolve test',
      timeoutMs: 5000,
    });

    // Wait for subscribe to fire
    await Bun.sleep(10);

    const first = gw.resolve(capturedId, {
      outcome: 'approved',
      choice: 'approve',
      actor: 'test',
    });
    expect(first).toBe(true);

    const second = gw.resolve(capturedId, {
      outcome: 'rejected',
      choice: 'reject',
      actor: 'test',
    });
    expect(second).toBe(false);

    await promise; // clean up
  });

  // ── pending() returns outstanding requests ──

  it('pending() lists unresolved requests', async () => {
    const gw = new InMemoryApprovalGateway();

    expect(gw.pending()).toHaveLength(0);

    // Don't subscribe — let it dangle
    const promise = gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Pending test',
      timeoutMs: 100,
    });

    expect(gw.pending()).toHaveLength(1);
    expect(gw.pending()[0]!.taskId).toBe('task-1');

    await promise; // let timeout resolve it
    expect(gw.pending()).toHaveLength(0);
  });

  // ── abortAll() ──

  it('abortAll() resolves all pending with aborted outcome', async () => {
    const gw = new InMemoryApprovalGateway();
    const events: string[] = [];

    gw.subscribe((event) => {
      events.push(event.type);
    });

    const p1 = gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'First',
      timeoutMs: 10000,
    });

    const p2 = gw.request({
      taskId: 'task-2',
      trackId: 'track-1',
      message: 'Second',
      timeoutMs: 10000,
    });

    expect(gw.pending()).toHaveLength(2);

    gw.abortAll('pipeline cancelled');

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.outcome).toBe('aborted');
    expect(d1.reason).toBe('pipeline cancelled');
    expect(d2.outcome).toBe('aborted');
    expect(gw.pending()).toHaveLength(0);
    expect(events.filter(e => e === 'aborted')).toHaveLength(2);
  });

  // ── listener exception is swallowed ──

  it('swallows listener exceptions without breaking emit', async () => {
    const gw = new InMemoryApprovalGateway();
    const received: string[] = [];

    // First listener throws
    gw.subscribe(() => {
      throw new Error('boom');
    });

    // Second listener should still fire
    gw.subscribe((event) => {
      received.push(event.type);
      if (event.type === 'requested') {
        gw.resolve(event.request.id, {
          outcome: 'approved',
          choice: 'approve',
          actor: 'test',
        });
      }
    });

    const decision = await gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Exception test',
      timeoutMs: 5000,
    });

    expect(decision.outcome).toBe('approved');
    expect(received).toContain('requested');
    expect(received).toContain('resolved');
  });

  // ── unsubscribe works ──

  it('unsubscribe() prevents further listener calls', async () => {
    const gw = new InMemoryApprovalGateway();
    let count = 0;

    const unsub = gw.subscribe(() => {
      count++;
    });

    const p1 = gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Before unsub',
      timeoutMs: 50,
    });
    await p1;

    const countAfterFirst = count;
    unsub();

    const p2 = gw.request({
      taskId: 'task-2',
      trackId: 'track-1',
      message: 'After unsub',
      timeoutMs: 50,
    });
    await p2;

    // After unsubscribe, the listener count should not have increased
    // (only the 'requested' event from p2 would have been emitted, but listener is gone)
    expect(count).toBe(countAfterFirst);
  });

  // ── default options ──

  it('uses default options when none provided', async () => {
    const gw = new InMemoryApprovalGateway();

    gw.subscribe((event) => {
      if (event.type === 'requested') {
        expect(event.request.options).toEqual(['approve', 'reject']);
        gw.resolve(event.request.id, {
          outcome: 'approved',
          choice: 'approve',
          actor: 'test',
        });
      }
    });

    await gw.request({
      taskId: 'task-1',
      trackId: 'track-1',
      message: 'Default options',
      timeoutMs: 1000,
    });
  });
});
