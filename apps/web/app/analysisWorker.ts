// Web Worker entry for the browser-independent analysis pipeline
// (imageAnalysis.ts): decode + ICC + downscale + survey off the main thread.
// Bundled by webpack via `new Worker(new URL("./analysisWorker.ts",
// import.meta.url))` written inline in analysisClient.ts — that exact shape is
// what webpack recognizes as a worker entry and emits as a JS chunk under the
// basePath. (PR #12's module worker broke on the static export because the
// URL was built in a separate variable, so webpack treated it as a raw asset
// and shipped the .ts file.)

import { analyzeImageBytes, type AnalysisMode, type ImageAnalysisResult } from "./imageAnalysis";

export type AnalysisWorkerRequest = { id: number; bytes: ArrayBuffer; mode: AnalysisMode };
export type AnalysisWorkerResponse =
  | { id: number; ok: true; result: ImageAnalysisResult }
  | { id: number; ok: false; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: AnalysisWorkerResponse, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, bytes, mode } = event.data;
  analyzeImageBytes(new Uint8Array(bytes), mode).then(
    (result) => scope.postMessage({ id, ok: true, result }, [result.pixels.data.buffer]),
    (error: unknown) =>
      scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  );
};
