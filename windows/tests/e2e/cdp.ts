// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket and
// fetch — just what the end-to-end suite needs, with no dependency to install.
//
// WebView2 exposes CDP only when it is started with --remote-debugging-port,
// which the suite passes to its own side instance alone (see harness.ts).

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

type Listener = (params: Record<string, unknown>) => void;

export class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id != null) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`CDP: ${msg.error.message}`));
        else waiter.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
      }
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  /** Lists the debuggable targets of the WebView2 instance on `port`. */
  static async targets(port: number): Promise<CdpTarget[]> {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await res.json()) as CdpTarget[];
  }

  /** Connects to the first page target accepted by `match`, waiting for it to appear. */
  static async connect(
    port: number,
    match: (t: CdpTarget) => boolean,
    timeoutMs = 30_000,
  ): Promise<{ cdp: Cdp; target: CdpTarget }> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const target = (await Cdp.targets(port)).find((t) => t.type === "page" && match(t));
        if (target) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
          });
          return { cdp: new Cdp(ws), target };
        }
      } catch (err) {
        lastError = err; // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no matching CDP target on port ${port} within ${timeoutMs} ms (${String(lastError)})`);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Evaluates an expression in the page and returns its JSON value. Page exceptions throw. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value as T;
  }

  /** PNG of the page, with a transparent background so the island's shape shows. */
  async screenshot(): Promise<Buffer> {
    await this.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
