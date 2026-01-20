type EventHandler = (data: unknown) => void;

/**
 * SSE client with auto-reconnect and event handling
 */
export class SSEClient {
  private eventSource: EventSource | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();
  private url: string = "/api/events";

  /**
   * Register event handler
   */
  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  /**
   * Emit event to handlers (for testing and internal use)
   */
  emit(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  /**
   * Connect to SSE endpoint
   */
  connect(url: string = "/api/events"): void {
    this.url = url;
    this.eventSource = new EventSource(url);

    this.eventSource.onopen = () => {
      console.log("[SSE] Connected");
      this.emit("_connected", {});
    };

    this.eventSource.onerror = (err) => {
      console.error("[SSE] Error, will auto-reconnect", err);
      this.emit("_error", err);
    };

    // Listen for all event types we care about
    const eventTypes = ["connected", "coach", "metrics", "target"];

    for (const type of eventTypes) {
      this.eventSource.addEventListener(type, (event: MessageEvent) => {
        try {
          console.log(`[SSE] Received ${type}:`, event.data);
          const data = JSON.parse(event.data);
          this.emit(type, data);
        } catch (error) {
          console.error(`[SSE] Failed to parse ${type} event:`, error);
        }
      });
    }
  }

  /**
   * Disconnect from SSE endpoint
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}
