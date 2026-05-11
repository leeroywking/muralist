// Main-thread wrapper for the palette worker. Owns a single worker
// instance, multiplexes classify + flatten requests over it via request
// ids, and returns Promise-based results. SSR-safe: worker creation is
// deferred to the first call and guarded by `typeof window !== "undefined"`.

import type {
  ClassifyRequest,
  ClassifyResponse,
  FlattenPaletteEntry,
  FlattenRequest,
  FlattenResponse
} from "./paletteWorker";

type WorkerResponse = ClassifyResponse | FlattenResponse;

let workerInstance: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<
  number,
  {
    resolve: (data: WorkerResponse) => void;
    reject: (err: Error) => void;
  }
>();

function ensureWorker(): Worker {
  if (workerInstance) return workerInstance;
  if (typeof window === "undefined") {
    throw new Error("Palette worker requires a browser environment.");
  }
  // `import.meta.url` is the Next.js-recommended pattern for Worker scripts
  // and is supported at runtime by the webpack/SWC bundler. The repo's
  // shared tsconfig (`module: NodeNext`) flags it at typecheck — narrow
  // suppression below, see AGENTS.md note in handover comments.
  // @ts-expect-error import.meta.url is valid at runtime via Next's bundler.
  const workerUrl = new URL("./paletteWorker.ts", import.meta.url);
  workerInstance = new Worker(workerUrl, { type: "module" });
  workerInstance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { requestId } = event.data;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.resolve(event.data);
  };
  workerInstance.onerror = (err) => {
    for (const [id, entry] of pending) {
      entry.reject(new Error(`Palette worker error: ${err.message || "unknown"}`));
      pending.delete(id);
    }
  };
  return workerInstance;
}

export type ClassifyResult = Omit<ClassifyResponse, "type" | "requestId">;
export type FlattenResult = Omit<FlattenResponse, "type" | "requestId">;

export function requestClassify(
  clusters: ClassifyRequest["clusters"],
  options: ClassifyRequest["options"],
  lockedIds: Iterable<string>
): Promise<ClassifyResult> {
  const worker = ensureWorker();
  const requestId = ++nextRequestId;
  return new Promise<ClassifyResult>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (data) => {
        if (data.type !== "classify-result") {
          reject(new Error(`Unexpected response type: ${data.type}`));
          return;
        }
        const { type: _type, requestId: _id, ...rest } = data;
        resolve(rest);
      },
      reject
    });
    const message: ClassifyRequest = {
      type: "classify",
      requestId,
      clusters,
      options,
      lockedIds: Array.from(lockedIds)
    };
    worker.postMessage(message);
  });
}

export function requestFlatten(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  palette: FlattenPaletteEntry[]
): Promise<FlattenResult> {
  const worker = ensureWorker();
  const requestId = ++nextRequestId;
  return new Promise<FlattenResult>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (data) => {
        if (data.type !== "flatten-result") {
          reject(new Error(`Unexpected response type: ${data.type}`));
          return;
        }
        const { type: _type, requestId: _id, ...rest } = data;
        resolve(rest);
      },
      reject
    });
    // Send a copy of `source` (default postMessage behavior); the main
    // thread keeps its sourcePixelsRef around for future flatten requests
    // and for art-tap pixel sampling. The output buffer comes back
    // transferred from the worker, since the worker doesn't need it after.
    const message: FlattenRequest = {
      type: "flatten",
      requestId,
      source,
      width,
      height,
      palette
    };
    worker.postMessage(message);
  });
}
