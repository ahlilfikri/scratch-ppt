"use client";
import { FontPicker } from "@/components/ui/font-picker";
export const FontLoader = ({ fontsToLoad }: { fontsToLoad: string[] }) => {
  if (fontsToLoad.length === 0) return null;

  return (
    <div style={{ display: "none" }}>
      <FontPicker loadFonts={fontsToLoad} loaderOnly />
    </div>
  );
};
