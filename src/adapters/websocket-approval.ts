import type { ApprovalGateway, ApprovalEvent } from '../approval';

// ═══ WebSocket Approval Adapter ═══
//
// Bridges the ApprovalGateway to WebSocket clients (e.g. a frontend UI).
// Mirrors the stdin-approval adapter pattern: subscribe to gateway events,
// forward them as JSON to all connected clients, and call gateway.resolve()
// when a client sends a resolution message.
//
// Protocol — server → client:
//   { type: 'pending',             requests: ApprovalRequest[] }   ← sent on connect
//   { type: 'approval_requested',  request:  ApprovalRequest }
//   { type: 'approval_resolved',   request:  ApprovalRequest, decision: ApprovalDecision }
//   { type: 'approval_expired',    request:  ApprovalRequest }
//   { type: 'approval_aborted',    request:  ApprovalRequest, reason: string }
//
// Protocol — client → server:
//   { type: 'resolve', approvalId: string, outcome: 'approved'|'rejected',
//     choice?: string, actor?: string, reason?: string }

export interface WebSocketApprovalAdapterOptions {
  port?: number;      // default: 3000
  hostname?: string;  // default: 'localhost'
}

export interface WebSocketApprovalAdapter {
  readonly port: number;
  readonly detach: () => void;
}

export function attachWebSocketApprovalAdapter(
  gateway: ApprovalGateway,
  options: WebSocketApprovalAdapterOptions = {},
): WebSocketApprovalAdapter {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? 'localhost';

  const clients = new Set<import('bun').ServerWebSocket<unknown>>();

  function broadcast(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(text);
    }
  }

  const unsubscribe = gateway.subscribe((event: ApprovalEvent) => {
    switch (event.type) {
      case 'requested':
        broadcast({ type: 'approval_requested', request: event.request });
        break;
      case 'resolved':
        broadcast({ type: 'approval_resolved', request: event.request, decision: event.decision });
        break;
      case 'expired':
        broadcast({ type: 'approval_expired', request: event.request });
        break;
      case 'aborted':
        broadcast({ type: 'approval_aborted', request: event.request, reason: event.reason });
        break;
    }
  });

  const server = Bun.serve({
    port,
    hostname,

    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response('tagma-sdk WebSocket approval endpoint', { status: 426 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        // Sync current pending approvals to newly connected client.
        ws.send(JSON.stringify({ type: 'pending', requests: gateway.pending() }));
      },

      message(ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
          return;
        }

        if (!isResolveMessage(msg)) {
          ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
          return;
        }

        const ok = gateway.resolve(msg.approvalId, {
          outcome: msg.outcome,
          choice: msg.choice,
          actor: msg.actor ?? 'websocket',
          reason: msg.reason,
        });

        if (!ok) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `approval ${msg.approvalId} not found or already resolved`,
          }));
        }
      },

      close(ws) {
        clients.delete(ws);
      },
    },
  });

  return {
    port: server.port!,
    detach() {
      unsubscribe();
      clients.clear();
      server.stop(true);
    },
  };
}

// ── Type guard ──

interface ResolveMessage {
  type: 'resolve';
  approvalId: string;
  outcome: 'approved' | 'rejected';
  choice?: string;
  actor?: string;
  reason?: string;
}

function isResolveMessage(v: unknown): v is ResolveMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m['type'] === 'resolve' &&
    typeof m['approvalId'] === 'string' &&
    (m['outcome'] === 'approved' || m['outcome'] === 'rejected')
  );
}
