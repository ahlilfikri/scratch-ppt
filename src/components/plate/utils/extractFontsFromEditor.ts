import { FontFamilyPlugin } from "@platejs/basic-styles/react";
import { type PlateEditor } from "platejs/react";

export function extractFontsFromEditor(editor: PlateEditor) {
  const fontFamilies = new Set<string>();

  // Scan all nodes for font family marks
  try {
    for (const [node] of editor.api.nodes({
      at: [],
      match: (n) => {
        const nodeWithFont = n as {
          text?: string;
          [key: string]: unknown;
        };
        return Boolean(nodeWithFont.text && nodeWithFont[FontFamilyPlugin.key]);
      },
    })) {
      const nodeWithFont = node as {
        text: string;
        [key: string]: unknown;
      };
      if (nodeWithFont[FontFamilyPlugin.key]) {
        const nodeFontFamily = nodeWithFont[FontFamilyPlugin.key] as string;
        fontFamilies.add(nodeFontFamily);
      }
    }
  } catch (error) {
    console.error("Error scanning editor for fonts:", error);
    return [];
  }

  // Convert Set to array and update state
  const fontsArray = Array.from(fontFamilies);
  return fontsArray;
}
