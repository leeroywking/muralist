/// <reference lib="webworker" />
// Off-main-thread classifier + flatten compute. Keeps the UI responsive
// while pullColorOut and flattenImageToPalette do their heavy work —
// classify is O(n³) worst case on Phase 0 dedup, flatten is a per-pixel
// nearest-match loop. See docs/plans/unmerge-colors.md §7 follow-up.
import { applyClassification, classifyPaletteColors } from "@muralist/core";
self.onmessage = (event)=>{
    const msg = event.data;
    if (msg.type === "classify") {
        const classified = classifyPaletteColors(msg.clusters, {
            ...msg.options,
            lockedIds: msg.lockedIds.length > 0 ? new Set(msg.lockedIds) : undefined
        });
        const applied = applyClassification(msg.clusters, classified);
        const response = {
            type: "classify-result",
            requestId: msg.requestId,
            classified,
            nextColors: applied.nextColors,
            mixes: applied.mixes,
            absorbedCount: applied.absorbedCount
        };
        self.postMessage(response);
        return;
    }
    if (msg.type === "flatten") {
        const output = flattenPixels(msg.source, msg.width, msg.palette);
        const response = {
            type: "flatten-result",
            requestId: msg.requestId,
            output
        };
        self.postMessage(response, [
            output.buffer
        ]);
        return;
    }
};
function flattenPixels(source, width, palette) {
    const out = new Uint8ClampedArray(source.length);
    const HATCH_BASE_R = 229, HATCH_BASE_G = 231, HATCH_BASE_B = 235;
    const HATCH_STROKE_R = 31, HATCH_STROKE_G = 41, HATCH_STROKE_B = 55;
    for(let i = 0; i < source.length; i += 4){
        var _source_;
        const alpha = (_source_ = source[i + 3]) !== null && _source_ !== void 0 ? _source_ : 0;
        if (alpha < 128) {
            out[i + 3] = 0;
            continue;
        }
        var _source_i;
        const r = (_source_i = source[i]) !== null && _source_i !== void 0 ? _source_i : 0;
        var _source_1;
        const g = (_source_1 = source[i + 1]) !== null && _source_1 !== void 0 ? _source_1 : 0;
        var _source_2;
        const b = (_source_2 = source[i + 2]) !== null && _source_2 !== void 0 ? _source_2 : 0;
        let bestIndex = 0;
        let bestDistance = Infinity;
        for(let p = 0; p < palette.length; p += 1){
            const [pr, pg, pb] = palette[p].rgb;
            const dr = r - pr;
            const dg = g - pg;
            const db = b - pb;
            const d = dr * dr + dg * dg + db * db;
            if (d < bestDistance) {
                bestDistance = d;
                bestIndex = p;
            }
        }
        const best = palette[bestIndex];
        if (best.disabled) {
            const pixelIdx = i >> 2;
            const x = pixelIdx % width;
            const y = (pixelIdx - x) / width;
            const isStripe = (x + y) % 6 < 2;
            out[i] = isStripe ? HATCH_STROKE_R : HATCH_BASE_R;
            out[i + 1] = isStripe ? HATCH_STROKE_G : HATCH_BASE_G;
            out[i + 2] = isStripe ? HATCH_STROKE_B : HATCH_BASE_B;
            out[i + 3] = 255;
        } else {
            out[i] = best.rgb[0];
            out[i + 1] = best.rgb[1];
            out[i + 2] = best.rgb[2];
            out[i + 3] = 255;
        }
    }
    return out;
}
