import type { ChunkJob, ChunkResult } from './ChunkBuilder';
import type { MapJob } from './chunk.worker';

interface Pending {
  job: ChunkJob;
  priority: number;
  cb: (r: ChunkResult) => void;
}

/**
 * A pool of chunk workers with a priority queue. The owner re-prioritises every frame, so
 * jobs that are no longer needed can be dropped before they ever reach a worker.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue = new Map<string, Pending>();
  private inflight = new Map<number, (r: ChunkResult) => void>();
  private mapCbs = new Map<number, (px: Uint8ClampedArray, job: MapJob) => void>();
  private mapQueue: MapJob[] = [];
  readonly size: number;
  jobsDone = 0;
  totalMs = 0;

  constructor(seed: string, count: number) {
    this.size = count;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', seed });
      w.onmessage = (ev) => this.onMessage(i, ev.data);
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  private onMessage(i: number, msg: any): void {
    this.busy[i] = false;
    if (msg.type === 'chunk') {
      const cb = this.inflight.get(i);
      this.inflight.delete(i);
      this.jobsDone++;
      this.totalMs += msg.res.ms;
      cb?.(msg.res);
    } else if (msg.type === 'map') {
      const cb = this.mapCbs.get(msg.id);
      this.mapCbs.delete(msg.id);
      cb?.(msg.px, msg.job);
    }
    this.pump();
  }

  /** Queue or re-prioritise a job. Lower priority value runs first. */
  request(job: ChunkJob, priority: number, cb: (r: ChunkResult) => void): void {
    this.queue.set(job.key, { job, priority, cb });
  }

  cancel(key: string): void {
    this.queue.delete(key);
  }

  has(key: string): boolean {
    return this.queue.has(key);
  }

  setPriority(key: string, p: number): void {
    const q = this.queue.get(key);
    if (q) q.priority = p;
  }

  requestMap(job: MapJob, cb: (px: Uint8ClampedArray, job: MapJob) => void): void {
    this.mapCbs.set(job.id, cb);
    this.mapQueue.push(job);
    this.pump();
  }

  get queued(): number {
    return this.queue.size;
  }

  get active(): number {
    return this.busy.filter(Boolean).length;
  }

  pump(): void {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i]) continue;
      // Map tiles only use idle capacity, keeping one worker free for terrain when possible.
      if (this.mapQueue.length && (this.queue.size === 0 || i === this.workers.length - 1)) {
        const job = this.mapQueue.shift()!;
        this.busy[i] = true;
        this.workers[i].postMessage({ type: 'map', job });
        continue;
      }
      if (this.queue.size === 0) continue;
      let best: Pending | null = null;
      for (const p of this.queue.values()) if (!best || p.priority < best.priority) best = p;
      if (!best) continue;
      this.queue.delete(best.job.key);
      this.busy[i] = true;
      this.inflight.set(i, best.cb);
      this.workers[i].postMessage({ type: 'chunk', job: best.job }, [best.job.edits.buffer]);
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
