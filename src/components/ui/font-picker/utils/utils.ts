import { type Font, type FourFonts, type Variant } from "../types";

// Helper to get the sprite number for a given font index
export function getSpriteNumber(index: number): number {
  return Math.floor(index / 200) + 1;
}

export const getFourVariants = (variants: string[]) => {
  const regularWeights = variants
    .filter((v: string) => v.substring(0, 2) === "0,")
    .map((v: string) => parseInt(v.substring(2), 10))
    .sort((a, b) => a - b);
  const italicWeights = variants
    .filter((v: string) => v.substring(0, 2) === "1,")
    .map((v: string) => parseInt(v.substring(2), 10))
    .sort((a, b) => a - b);

  const fourFonts: FourFonts = {};
  fourFonts.regular = regularWeights
    .sort((a, b) => Math.abs(399 - a) - Math.abs(399 - b))
    .shift();
  fourFonts.bold = regularWeights
    .filter((v) => v > (fourFonts.regular || 0))
    .sort((a, b) => Math.abs(700 - a) - Math.abs(700 - b))
    .shift();
  fourFonts.italic = italicWeights
    .sort((a, b) => Math.abs(399 - a) - Math.abs(399 - b))
    .shift();
  fourFonts.boldItalic = italicWeights
    .filter((v) => v > (fourFonts.italic || 0))
    .sort((a, b) => Math.abs(700 - a) - Math.abs(700 - b))
    .shift();

  const fourVariants: string[] = [];
  if (fourFonts.regular) {
    fourVariants.push("0," + fourFonts.regular);
  }
  if (fourFonts.bold) {
    fourVariants.push("0," + fourFonts.bold);
  }
  if (fourFonts.italic) {
    fourVariants.push("1," + fourFonts.italic);
  }
  if (fourFonts.boldItalic) {
    fourVariants.push("1," + fourFonts.boldItalic);
  }
  return fourVariants;
};

export const loadFontFromObject = (
  font: Font,
  loadAllVariants: boolean,
  getFourVariants: (variants: string[]) => string[],
  variants: Variant[] = [],
) => {
  if (font?.isLocal) {
    return;
  }
  if (variants?.length > 0) {
    variants = font.variants.filter((v: Variant) => variants.includes(v));
  } else if (loadAllVariants) {
    variants = font.variants;
  } else {
    variants = getFourVariants(font.variants.map((v) => v.toString()));
  }

  let cssId = "google-font-" + font.sane;
  const cssIdAll = cssId + "-all";
  if (variants.length === font.variants.length) {
    cssId = cssIdAll;
  } else {
    cssId +=
      "-" +
      variants.sort().join("-").replaceAll("1,", "i").replaceAll("0,", "");
  }

  const existing = document.getElementById(cssId);
  const existingAll = document.getElementById(cssIdAll);
  if (!existing && !existingAll && font?.name && variants?.length > 0) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = cssId;
    link.href =
      "https://fonts.googleapis.com/css2?family=" +
      font.name +
      ":ital,wght@" +
      variants.sort().join(";") +
      "&display=swap";
    link.setAttribute("data-testid", cssId);
    document.head.appendChild(link);
  }
};
