import type { WebSocket } from 'ws';
import type { WSEvent } from '@sniff/shared';

export class WebSocketHub {
  private clients = new Set<WebSocket>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        // WebSocket.OPEN
        client.send(message);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

// Singleton
export const wsHub = new WebSocketHub();
