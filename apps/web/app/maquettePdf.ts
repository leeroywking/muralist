import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  rgb
} from "pdf-lib";
import { buildMaquetteFileName } from "@muralist/core";
import type { FieldSheetColor, FieldSheetModel } from "./PrototypeApp";

export type DownloadMaquettePdfInput = {
  model: FieldSheetModel;
  originalImageUrl: string | null;
  reducedImageUrl: string | null;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ART_ROW_HEIGHT = 210;
const ART_CAPTION_HEIGHT = 30;
const ART_FRAME_HEIGHT = ART_ROW_HEIGHT - ART_CAPTION_HEIGHT;
const ART_GAP = 16;
const ART_HALF_WIDTH = (CONTENT_WIDTH - ART_GAP) / 2;
const MIDDLE_ROW_HEIGHT = 350;
const SWATCH_COLUMN_WIDTH = 192;
const SWATCH_COLUMN_GAP = 16;
const NOTES_ROW_HEIGHT = 102;
const HEADER_HEIGHT = 28;
const ROW_GAP = 10;
const RASTER_MAX_EDGE = 1200;

const INK = rgb(0.08, 0.09, 0.12);
const MUTED = rgb(0.35, 0.38, 0.45);
const RULE = rgb(0.78, 0.80, 0.85);
const WARN_FILL = rgb(0.99, 0.93, 0.82);
const WARN_INK = rgb(0.55, 0.32, 0.04);
const WORKSPACE_GUIDE = rgb(0.88, 0.90, 0.94);

export async function downloadMaquettePdf(input: DownloadMaquettePdfInput): Promise<void> {
  const { model, originalImageUrl, reducedImageUrl } = input;

  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const [originalImage, reducedImage] = await Promise.all([
    originalImageUrl ? embedRasterImage(doc, originalImageUrl) : Promise.resolve(null),
    reducedImageUrl ? embedRasterImage(doc, reducedImageUrl) : Promise.resolve(null)
  ]);

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const fonts = { regular: helvetica, bold: helveticaBold };

  let cursorY = PAGE_HEIGHT - MARGIN;

  cursorY = drawHeader(page, fonts, model, cursorY);
  cursorY -= ROW_GAP;

  if (model.aspectRatio.shouldWarn) {
    cursorY = drawRatioWarning(page, fonts, cursorY);
    cursorY -= ROW_GAP;
  }

  cursorY = drawArtRow(page, fonts, model, originalImage, reducedImage, cursorY);
  cursorY -= ROW_GAP;

  const firstPageRowCount = computeFirstPageSwatchCapacity(model.colors.length);
  const firstPageColors = model.colors.slice(0, firstPageRowCount);
  const overflowColors = model.colors.slice(firstPageRowCount);

  cursorY = drawMiddleRow(page, fonts, model, firstPageColors, cursorY);
  cursorY -= ROW_GAP;

  drawNotesAndTotals(page, fonts, model, cursorY);

  if (overflowColors.length > 0) {
    drawOverflowPages(doc, fonts, model, overflowColors);
  }

  const bytes = await doc.save();
  triggerDownload(bytes, `${buildMaquetteFileName(model.fileName)}.pdf`);
}

function computeFirstPageSwatchCapacity(colorCount: number): number {
  return colorCount <= 10 ? colorCount : 10;
}

function drawHeader(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  topY: number
): number {
  const titleY = topY - 12;
  page.drawText("Muralist Field Sheet", {
    x: MARGIN,
    y: titleY,
    size: 14,
    font: fonts.bold,
    color: INK
  });

  const meta = `${model.wall.widthFt} ft × ${model.wall.heightFt} ft · ${model.grid.columns} × ${model.grid.rows} cells at ${model.grid.cellSizeFt} ft · ${model.brandLabel} (${model.retailer})`;
  const metaWidth = fonts.regular.widthOfTextAtSize(meta, 8.5);
  page.drawText(meta, {
    x: PAGE_WIDTH - MARGIN - metaWidth,
    y: titleY + 1,
    size: 8.5,
    font: fonts.regular,
    color: MUTED
  });

  const ruleY = topY - HEADER_HEIGHT;
  page.drawLine({
    start: { x: MARGIN, y: ruleY },
    end: { x: PAGE_WIDTH - MARGIN, y: ruleY },
    thickness: 0.5,
    color: RULE
  });

  return ruleY;
}

function drawRatioWarning(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  topY: number
): number {
  const height = 22;
  const y = topY - height;
  page.drawRectangle({
    x: MARGIN,
    y,
    width: CONTENT_WIDTH,
    height,
    color: WARN_FILL
  });
  const message =
    "Wall ratio differs from the uploaded artwork. Reduced mural preview is stretched to the wall size so the mismatch is obvious before painting.";
  page.drawText(message, {
    x: MARGIN + 8,
    y: y + 7,
    size: 8,
    font: fonts.regular,
    color: WARN_INK,
    maxWidth: CONTENT_WIDTH - 16
  });
  return y;
}

function drawArtRow(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  originalImage: PDFImage | null,
  reducedImage: PDFImage | null,
  topY: number
): number {
  const sourceAspectRatio = model.sourceSize.widthPx / model.sourceSize.heightPx;
  const wallAspectRatio = model.wall.widthFt / model.wall.heightFt;
  const frameTop = topY;
  const frameBottom = topY - ART_FRAME_HEIGHT;

  drawArtPanel({
    page,
    fonts,
    x: MARGIN,
    top: frameTop,
    width: ART_HALF_WIDTH,
    frameHeight: ART_FRAME_HEIGHT,
    aspectRatio: sourceAspectRatio,
    image: originalImage,
    gridLines: buildGridLinePositions(model),
    label: "Original artwork",
    caption: "Source ratio preserved."
  });

  drawArtPanel({
    page,
    fonts,
    x: MARGIN + ART_HALF_WIDTH + ART_GAP,
    top: frameTop,
    width: ART_HALF_WIDTH,
    frameHeight: ART_FRAME_HEIGHT,
    aspectRatio: wallAspectRatio,
    image: reducedImage,
    gridLines: buildGridLinePositions(model),
    label: "Reduced mural preview",
    caption: "Fit to wall dimensions. Grid cells show real-world spacing."
  });

  const captionY = frameBottom - ART_CAPTION_HEIGHT;
  return captionY;
}

function drawArtPanel(args: {
  page: PDFPage;
  fonts: { regular: PDFFont; bold: PDFFont };
  x: number;
  top: number;
  width: number;
  frameHeight: number;
  aspectRatio: number;
  image: PDFImage | null;
  gridLines: { vertical: number[]; horizontal: number[] };
  label: string;
  caption: string;
}): void {
  const { page, fonts, x, top, width, frameHeight, aspectRatio, image, gridLines, label, caption } = args;
  const frameBottom = top - frameHeight;

  page.drawRectangle({
    x,
    y: frameBottom,
    width,
    height: frameHeight,
    borderColor: RULE,
    borderWidth: 0.5
  });

  let drawWidth = width;
  let drawHeight = width / aspectRatio;
  if (drawHeight > frameHeight) {
    drawHeight = frameHeight;
    drawWidth = frameHeight * aspectRatio;
  }
  const drawX = x + (width - drawWidth) / 2;
  const drawY = frameBottom + (frameHeight - drawHeight) / 2;

  if (image) {
    page.drawImage(image, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });
  } else {
    const placeholder = "Preview unavailable";
    const size = 9;
    const textWidth = fonts.regular.widthOfTextAtSize(placeholder, size);
    page.drawText(placeholder, {
      x: x + (width - textWidth) / 2,
      y: frameBottom + frameHeight / 2 - size / 2,
      size,
      font: fonts.regular,
      color: MUTED
    });
  }

  for (const verticalPct of gridLines.vertical) {
    const gx = drawX + (verticalPct / 100) * drawWidth;
    page.drawLine({
      start: { x: gx, y: drawY },
      end: { x: gx, y: drawY + drawHeight },
      thickness: 0.35,
      color: rgb(1, 1, 1),
      opacity: 0.7
    });
  }
  for (const horizontalPct of gridLines.horizontal) {
    const gy = drawY + drawHeight - (horizontalPct / 100) * drawHeight;
    page.drawLine({
      start: { x: drawX, y: gy },
      end: { x: drawX + drawWidth, y: gy },
      thickness: 0.35,
      color: rgb(1, 1, 1),
      opacity: 0.7
    });
  }

  page.drawText(label, {
    x,
    y: frameBottom - 12,
    size: 9,
    font: fonts.bold,
    color: INK
  });
  page.drawText(caption, {
    x,
    y: frameBottom - 23,
    size: 7.5,
    font: fonts.regular,
    color: MUTED,
    maxWidth: width
  });
}

function drawMiddleRow(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  colors: FieldSheetColor[],
  topY: number
): number {
  const bottom = topY - MIDDLE_ROW_HEIGHT;
  const swatchX = MARGIN + CONTENT_WIDTH - SWATCH_COLUMN_WIDTH;
  const workspaceRight = swatchX - SWATCH_COLUMN_GAP;

  drawWorkspace(page, fonts, MARGIN, workspaceRight, topY, bottom);
  drawSwatchTable(page, fonts, model, colors, swatchX, topY, MIDDLE_ROW_HEIGHT);

  return bottom;
}

function drawWorkspace(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  left: number,
  right: number,
  top: number,
  bottom: number
): void {
  const width = right - left;
  const height = top - bottom;

  page.drawRectangle({
    x: left,
    y: bottom,
    width,
    height,
    borderColor: RULE,
    borderWidth: 0.5
  });

  page.drawText("Workspace", {
    x: left + 8,
    y: top - 14,
    size: 8,
    font: fonts.bold,
    color: MUTED
  });
  page.drawText("Test mixes, sketch thumbnails, mark match-ups.", {
    x: left + 8,
    y: top - 24,
    size: 7,
    font: fonts.regular,
    color: MUTED
  });

  const guideTop = top - 32;
  const guideBottom = bottom + 8;
  const guideStep = 24;
  for (let y = guideTop - guideStep; y > guideBottom; y -= guideStep) {
    page.drawLine({
      start: { x: left + 8, y },
      end: { x: right - 8, y },
      thickness: 0.3,
      color: WORKSPACE_GUIDE
    });
  }
}

function drawSwatchTable(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  colors: FieldSheetColor[],
  x: number,
  topY: number,
  height: number
): void {
  const width = SWATCH_COLUMN_WIDTH;
  const bottom = topY - height;
  const headerHeight = 18;

  page.drawRectangle({
    x,
    y: bottom,
    width,
    height,
    borderColor: RULE,
    borderWidth: 0.5
  });

  page.drawText("Paint plan", {
    x: x + 8,
    y: topY - 12,
    size: 9,
    font: fonts.bold,
    color: INK
  });
  page.drawLine({
    start: { x, y: topY - headerHeight },
    end: { x: x + width, y: topY - headerHeight },
    thickness: 0.5,
    color: RULE
  });

  const rowsTop = topY - headerHeight;
  const available = rowsTop - bottom;
  const rowHeight = colors.length > 0 ? available / colors.length : available;

  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index]!;
    const rowTop = rowsTop - index * rowHeight;
    drawSwatchRow(page, fonts, model, color, x, width, rowTop, rowHeight);
    if (index < colors.length - 1) {
      page.drawLine({
        start: { x: x + 6, y: rowTop - rowHeight },
        end: { x: x + width - 6, y: rowTop - rowHeight },
        thickness: 0.3,
        color: RULE
      });
    }
  }
}

function drawSwatchRow(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  color: FieldSheetColor,
  x: number,
  width: number,
  rowTop: number,
  rowHeight: number
): void {
  const swatchSize = Math.min(rowHeight - 6, 26);
  const swatchX = x + 6;
  const swatchY = rowTop - (rowHeight + swatchSize) / 2;
  const fill = parseHexColor(color.hex);

  page.drawRectangle({
    x: swatchX,
    y: swatchY,
    width: swatchSize,
    height: swatchSize,
    color: fill,
    borderColor: RULE,
    borderWidth: 0.5
  });

  const textLeft = swatchX + swatchSize + 8;
  const textRight = x + width - 6;
  const textWidth = textRight - textLeft;

  const percentLabel = `${color.coveragePercent.toFixed(1)}%`;
  const percentWidth = fonts.regular.widthOfTextAtSize(percentLabel, 8);
  const hexWidth = fonts.bold.widthOfTextAtSize(color.hex, 9);
  const lineOneY = rowTop - 10;
  page.drawText(color.hex, {
    x: textLeft,
    y: lineOneY,
    size: 9,
    font: fonts.bold,
    color: INK,
    maxWidth: textWidth - percentWidth - 4
  });
  void hexWidth;
  page.drawText(percentLabel, {
    x: textRight - percentWidth,
    y: lineOneY,
    size: 8,
    font: fonts.regular,
    color: MUTED
  });

  const lineTwo = `${color.areaSqFt.toFixed(1)} sq ft · ${color.finishLabel} · ${color.coats}c`;
  page.drawText(lineTwo, {
    x: textLeft,
    y: rowTop - 19,
    size: 7.5,
    font: fonts.regular,
    color: MUTED,
    maxWidth: textWidth
  });

  const lineThree = `${color.packageLabel} · ${formatCurrency(color.estimatedCost, model.currency)}`;
  page.drawText(lineThree, {
    x: textLeft,
    y: rowTop - 28,
    size: 7.5,
    font: fonts.regular,
    color: INK,
    maxWidth: textWidth
  });
}

function drawNotesAndTotals(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  topY: number
): void {
  const bottom = topY - NOTES_ROW_HEIGHT;
  const totalsWidth = SWATCH_COLUMN_WIDTH;
  const notesRight = MARGIN + CONTENT_WIDTH - totalsWidth - SWATCH_COLUMN_GAP;
  const notesLeft = MARGIN;

  page.drawRectangle({
    x: notesLeft,
    y: bottom,
    width: notesRight - notesLeft,
    height: NOTES_ROW_HEIGHT,
    borderColor: RULE,
    borderWidth: 0.5
  });
  page.drawText("Artist notes", {
    x: notesLeft + 8,
    y: topY - 13,
    size: 9,
    font: fonts.bold,
    color: INK
  });

  const notesText = model.artistNotes.trim() || "—";
  drawWrappedText(page, fonts.regular, notesText, {
    x: notesLeft + 8,
    top: topY - 26,
    width: notesRight - notesLeft - 16,
    lineHeight: 10,
    size: 8.5,
    color: INK,
    maxLines: Math.floor((NOTES_ROW_HEIGHT - 30) / 10)
  });

  const totalsLeft = MARGIN + CONTENT_WIDTH - totalsWidth;
  page.drawRectangle({
    x: totalsLeft,
    y: bottom,
    width: totalsWidth,
    height: NOTES_ROW_HEIGHT,
    borderColor: RULE,
    borderWidth: 0.5
  });
  page.drawText("Total", {
    x: totalsLeft + 8,
    y: topY - 13,
    size: 9,
    font: fonts.bold,
    color: INK
  });
  page.drawText(model.totals.packageLabel, {
    x: totalsLeft + 8,
    y: topY - 28,
    size: 9,
    font: fonts.bold,
    color: INK,
    maxWidth: totalsWidth - 16
  });
  page.drawText(formatOunces(model.totals.requiredGallons), {
    x: totalsLeft + 8,
    y: topY - 42,
    size: 8.5,
    font: fonts.regular,
    color: INK,
    maxWidth: totalsWidth - 16
  });
  page.drawText(formatCurrency(model.totals.estimatedCost, model.currency), {
    x: totalsLeft + 8,
    y: topY - 54,
    size: 8.5,
    font: fonts.regular,
    color: MUTED,
    maxWidth: totalsWidth - 16
  });
  page.drawText(
    `${model.wall.areaSqFt.toFixed(0)} sq ft · ${model.colors.length} colors · ${model.grid.cellSizeFt} ft grid`,
    {
      x: totalsLeft + 8,
      y: topY - 74,
      size: 7.5,
      font: fonts.regular,
      color: MUTED,
      maxWidth: totalsWidth - 16
    }
  );
  page.drawText("Paint over swatches with your final mixes before matching in store.", {
    x: totalsLeft + 8,
    y: topY - 88,
    size: 7,
    font: fonts.regular,
    color: MUTED,
    maxWidth: totalsWidth - 16
  });
}

function drawOverflowPages(
  doc: PDFDocument,
  fonts: { regular: PDFFont; bold: PDFFont },
  model: FieldSheetModel,
  overflowColors: FieldSheetColor[]
): void {
  const rowsPerPage = 24;
  for (let offset = 0; offset < overflowColors.length; offset += rowsPerPage) {
    const slice = overflowColors.slice(offset, offset + rowsPerPage);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const top = PAGE_HEIGHT - MARGIN;
    page.drawText("Additional paint plan", {
      x: MARGIN,
      y: top - 12,
      size: 12,
      font: fonts.bold,
      color: INK
    });
    page.drawLine({
      start: { x: MARGIN, y: top - 22 },
      end: { x: PAGE_WIDTH - MARGIN, y: top - 22 },
      thickness: 0.5,
      color: RULE
    });

    const tableTop = top - 30;
    const tableHeight = tableTop - MARGIN;
    const rowHeight = tableHeight / slice.length;
    const xStart = MARGIN;
    const fullWidth = CONTENT_WIDTH;
    for (let index = 0; index < slice.length; index += 1) {
      const color = slice[index]!;
      const rowTop = tableTop - index * rowHeight;
      drawSwatchRow(page, fonts, model, color, xStart, fullWidth, rowTop, rowHeight);
    }
  }
}

function drawWrappedText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  opts: {
    x: number;
    top: number;
    width: number;
    lineHeight: number;
    size: number;
    color: ReturnType<typeof rgb>;
    maxLines: number;
  }
): void {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, opts.size) <= opts.width) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  const toRender = lines.slice(0, opts.maxLines);
  if (lines.length > opts.maxLines && toRender.length > 0) {
    const lastIndex = toRender.length - 1;
    let tail = toRender[lastIndex]!;
    while (font.widthOfTextAtSize(`${tail}…`, opts.size) > opts.width && tail.length > 0) {
      tail = tail.slice(0, -1);
    }
    toRender[lastIndex] = `${tail}…`;
  }

  for (let index = 0; index < toRender.length; index += 1) {
    page.drawText(toRender[index]!, {
      x: opts.x,
      y: opts.top - index * opts.lineHeight,
      size: opts.size,
      font,
      color: opts.color
    });
  }
}

function buildGridLinePositions(model: FieldSheetModel) {
  const vertical: number[] = [];
  const horizontal: number[] = [];
  for (let column = 1; column < model.grid.columns; column += 1) {
    vertical.push(Math.min(100, ((column * model.grid.cellSizeFt) / model.wall.widthFt) * 100));
  }
  for (let row = 1; row < model.grid.rows; row += 1) {
    horizontal.push(Math.min(100, ((row * model.grid.cellSizeFt) / model.wall.heightFt) * 100));
  }
  return { vertical, horizontal };
}

function parseHexColor(hex: string): ReturnType<typeof rgb> {
  const cleaned = hex.replace(/^#/, "").trim();
  const value = cleaned.length === 3
    ? cleaned.split("").map((ch) => `${ch}${ch}`).join("")
    : cleaned;
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const safe = (channel: number) => (Number.isFinite(channel) ? Math.min(255, Math.max(0, channel)) : 0);
  return rgb(safe(red) / 255, safe(green) / 255, safe(blue) / 255);
}

async function embedRasterImage(doc: PDFDocument, imageUrl: string): Promise<PDFImage | null> {
  try {
    const pngBytes = await rasterizeToPng(imageUrl, RASTER_MAX_EDGE);
    return await doc.embedPng(pngBytes);
  } catch {
    return null;
  }
}

async function rasterizeToPng(imageUrl: string, maxEdge: number): Promise<Uint8Array> {
  const image = await loadHtmlImage(imageUrl);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context unavailable.");
  }
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), "image/png");
  });
  if (!blob) {
    throw new Error("Canvas PNG export failed.");
  }
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded for PDF embedding."));
    image.src = src;
  });
}

function triggerDownload(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const FLUID_OUNCES_PER_GALLON = 128;

function formatOunces(requiredGallons: number): string {
  const totalOunces = requiredGallons * FLUID_OUNCES_PER_GALLON;
  if (totalOunces >= FLUID_OUNCES_PER_GALLON) {
    return `${requiredGallons.toFixed(2)} gal (${totalOunces.toFixed(0)} oz)`;
  }
  return `${totalOunces.toFixed(1)} oz`;
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}
