import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { InMemoryApprovalGateway } from '../../src/approval';
import {
  attachWebSocketApprovalAdapter,
  type WebSocketApprovalAdapter,
} from '../../src/adapters/websocket-approval';

// ═══ Helpers ═══

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      ws.removeEventListener('message', handler);
      try {
        resolve(JSON.parse(ev.data as string) as Record<string, unknown>);
      } catch {
        reject(new Error(`Received non-JSON: ${ev.data}`));
      }
    };
    ws.addEventListener('message', handler);
  });
}

/** Connect and consume the initial 'pending' snapshot sent on open. */
async function openWs(port: number): Promise<[WebSocket, Record<string, unknown>]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.addEventListener('open', () => {
      nextMessage(ws).then((msg) => resolve([ws, msg]), reject);
    });
    ws.addEventListener('error', reject);
  });
}

// ═══ Test lifecycle ═══

let gw: InMemoryApprovalGateway;
let adapter: WebSocketApprovalAdapter;

beforeEach(() => {
  gw = new InMemoryApprovalGateway();
  // port: 0 → OS assigns a random free port
  adapter = attachWebSocketApprovalAdapter(gw, { port: 0 });
});

afterEach(() => {
  gw.abortAll('test teardown');
  adapter.detach();
});

// ═══ Connection handshake ═══

describe('WebSocketApprovalAdapter — connection', () => {
  it('sends a pending snapshot with an empty list on first connect', async () => {
    const [ws, initial] = await openWs(adapter.port);
    expect(initial['type']).toBe('pending');
    expect(initial['requests']).toEqual([]);
    ws.close();
  });

  it('includes pre-existing pending requests in the snapshot', async () => {
    // Create a pending request before any client connects
    let capturedId = '';
    gw.subscribe((ev) => { if (ev.type === 'requested') capturedId = ev.request.id; });
    gw.request({ taskId: 't1', trackId: 'tr1', message: 'Pre-existing', timeoutMs: 10_000 })
      .catch(() => {});

    await Bun.sleep(20); // let subscribe fire

    const [ws, initial] = await openWs(adapter.port);
    const requests = initial['requests'] as Array<{ id: string }>;
    expect(requests.some((r) => r.id === capturedId)).toBe(true);
    ws.close();
  });
});

// ═══ Gateway event broadcast ═══

describe('WebSocketApprovalAdapter — gateway broadcasts', () => {
  it('broadcasts approval_requested when a new request is created', async () => {
    const [ws, _initial] = await openWs(adapter.port);
    const msgPromise = nextMessage(ws);

    gw.request({ taskId: 'task-broadcast', trackId: 'tr1', message: 'Approve?', timeoutMs: 5_000 })
      .catch(() => {});

    const msg = await msgPromise;
    expect(msg['type']).toBe('approval_requested');
    expect((msg['request'] as { taskId: string })['taskId']).toBe('task-broadcast');
    ws.close();
  });
});

// ═══ Input validation ═══

describe('WebSocketApprovalAdapter — input validation', () => {
  it('rejects messages longer than 4096 bytes', async () => {
    const [ws, _initial] = await openWs(adapter.port);
    const msgPromise = nextMessage(ws);

    ws.send('x'.repeat(4097));

    const msg = await msgPromise;
    expect(msg['type']).toBe('error');
    expect(msg['message']).toContain('too large');
    ws.close();
  });

  it('rejects malformed JSON', async () => {
    const [ws, _initial] = await openWs(adapter.port);
    const msgPromise = nextMessage(ws);

    ws.send('not valid json {{{');

    const msg = await msgPromise;
    expect(msg['type']).toBe('error');
    expect(msg['message']).toContain('invalid JSON');
    ws.close();
  });

  it('rejects messages with an unknown type', async () => {
    const [ws, _initial] = await openWs(adapter.port);
    const msgPromise = nextMessage(ws);

    ws.send(JSON.stringify({ type: 'something_else' }));

    const msg = await msgPromise;
    expect(msg['type']).toBe('error');
    expect(msg['message']).toContain('unknown message type');
    ws.close();
  });

  it('enforces per-client rate limit of 10 messages per second', async () => {
    const [ws, _initial] = await openWs(adapter.port);

    // Collect the next 11 responses
    const responses: Record<string, unknown>[] = [];
    const collected = new Promise<void>((resolve) => {
      const handler = (ev: MessageEvent) => {
        responses.push(JSON.parse(ev.data as string) as Record<string, unknown>);
        if (responses.length >= 11) {
          ws.removeEventListener('message', handler);
          resolve();
        }
      };
      ws.addEventListener('message', handler);
    });

    // Send 11 invalid-JSON messages fast — messages 1-10 each get 'invalid JSON',
    // message 11 crosses the rate limit threshold and gets 'rate limit exceeded'.
    for (let i = 0; i < 11; i++) {
      ws.send('bad json');
    }

    await collected;

    // First 10 responses are 'invalid JSON'
    for (let i = 0; i < 10; i++) {
      expect(responses[i]!['type']).toBe('error');
      expect(responses[i]!['message']).toContain('invalid JSON');
    }

    // 11th response is the rate limit error
    expect(responses[10]!['type']).toBe('error');
    expect(responses[10]!['message']).toContain('rate limit');

    ws.close();
  });
});

// ═══ Resolve flow ═══

describe('WebSocketApprovalAdapter — resolve flow', () => {
  it('resolves a pending approval via a WebSocket resolve message', async () => {
    const [ws, _initial] = await openWs(adapter.port);

    let capturedId = '';
    gw.subscribe((ev) => { if (ev.type === 'requested') capturedId = ev.request.id; });

    const decisionPromise = gw.request({
      taskId: 'task-ws',
      trackId: 'tr1',
      message: 'WS approve?',
      timeoutMs: 5_000,
    });

    // Wait for the 'requested' event to propagate
    await Bun.sleep(50);
    expect(capturedId).toBeTruthy();

    ws.send(JSON.stringify({
      type: 'resolve',
      approvalId: capturedId,
      outcome: 'approved',
      choice: 'approve',
      actor: 'test-client',
    }));

    const decision = await decisionPromise;
    expect(decision.outcome).toBe('approved');
    expect(decision.actor).toBe('test-client');
    ws.close();
  });

  it('returns an error when resolving a non-existent approval ID', async () => {
    const [ws, _initial] = await openWs(adapter.port);
    const msgPromise = nextMessage(ws);

    ws.send(JSON.stringify({
      type: 'resolve',
      approvalId: 'nonexistent-id',
      outcome: 'approved',
    }));

    const msg = await msgPromise;
    expect(msg['type']).toBe('error');
    expect(msg['message']).toContain('not found');
    ws.close();
  });
});
