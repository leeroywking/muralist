export type PaintBrandProfile = {
    id: string;
    display_name: string;
    retailer: string;
    coverage: {
        min: number;
        default: number;
        max: number;
    };
    default_coats: number;
    confidence: string;
    notes: string;
    sources: string[];
};
export type PaintBrandCatalog = {
    version: number;
    units: {
        coverage: string;
    };
    brands: PaintBrandProfile[];
};
export declare function loadPaintBrandCatalog(): Promise<PaintBrandCatalog>;
