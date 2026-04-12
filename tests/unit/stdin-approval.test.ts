import { describe, it, expect } from 'bun:test';
import { InMemoryApprovalGateway } from '../../src/approval';
import { attachStdinApprovalAdapter } from '../../src/adapters/stdin-approval';

// ══════════════════════════════════════════════════════════════════════════════
// Scope note
// ──────────────────────────────────────────────────────────────────────────────
// attachStdinApprovalAdapter hard-codes process.stdin as its input source, so
// the interactive readline path (reading a line, matching aliases, resolving
// the gateway) cannot be exercised in a unit test without mocking process I/O.
//
// What IS testable without real stdin:
//   1. detach() — unsubscribes from the gateway and closes any open readline.
//   2. Queue-skip behaviour — when a request is already resolved by the time
//      processNext() runs, it is skipped and readline is never opened.
// ══════════════════════════════════════════════════════════════════════════════

// ═══ detach ═══

describe('StdinApprovalAdapter — detach()', () => {
  it('unsubscribes from the gateway so subsequent events are ignored', async () => {
    const gw = new InMemoryApprovalGateway();
    const adapter = attachStdinApprovalAdapter(gw);

    // Detach immediately — no readline is ever created because no 'requested'
    // event fires before detach.
    adapter.detach();

    // Emit a 'requested' event after detach via a short-lived request.
    const events: string[] = [];
    gw.subscribe((ev) => events.push(ev.type));

    // Let the request time out — adapter should not touch it.
    const decision = await gw.request({
      taskId: 'task-post-detach',
      trackId: 'tr1',
      message: 'After detach',
      timeoutMs: 50,
    });

    expect(decision.outcome).toBe('timeout');
    expect(events).toContain('requested');
    expect(events).toContain('expired');
    // No readline was created, so the process does not hang.
  });

  it('is safe to call detach() multiple times', () => {
    const gw = new InMemoryApprovalGateway();
    const adapter = attachStdinApprovalAdapter(gw);
    adapter.detach();
    expect(() => adapter.detach()).not.toThrow();
  });
});

// ═══ Queue skip — pre-resolved request ═══

describe('StdinApprovalAdapter — queue skip', () => {
  it('skips a request that is already resolved when processNext() runs', async () => {
    const gw = new InMemoryApprovalGateway();

    // Register an auto-resolver BEFORE the adapter so it fires first in
    // subscription order. When 'requested' emits:
    //   1. auto-resolver resolves the request → emits 'resolved'
    //   2. adapter queues the request → calls processNext()
    //   3. processNext checks gateway.pending() → empty → skips without readline
    gw.subscribe((ev) => {
      if (ev.type === 'requested') {
        gw.resolve(ev.request.id, { outcome: 'approved', actor: 'auto' });
      }
    });

    const adapter = attachStdinApprovalAdapter(gw);

    const decision = await gw.request({
      taskId: 'task-skip',
      trackId: 'tr1',
      message: 'Skip test',
      timeoutMs: 1_000,
    });

    expect(decision.outcome).toBe('approved');
    expect(decision.actor).toBe('auto');

    adapter.detach();
  });
});
