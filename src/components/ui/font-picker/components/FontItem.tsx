import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { type Font } from "../types";
import { useImageLoaded } from "../utils/useImageLoaded";
import { getSpriteNumber } from "../utils/utils";

export const FontItem = ({
  font,
  isCurrent,
  fontIndex,
}: {
  font: Font;
  isCurrent: boolean;
  fontIndex: number;
}) => {
  const spriteNumber = getSpriteNumber(fontIndex);

  const isSpriteLoaded = useImageLoaded(
    `/font-preview/sprite.${spriteNumber}.svg`,
  );

  return (
    <div
      className={cn(
        "flex w-full items-center rounded-sm px-1 py-2 transition-colors",
        isCurrent && "bg-accent",
      )}
    >
      {isSpriteLoaded ? (
        <div
          className={cn(`font-preview-${font.sane} w-full`, "dark:invert")}
          title={font.name}
        />
      ) : (
        <span>{font.name}</span>
      )}
      {isCurrent && <Check className="ml-auto h-4 w-4" />}
    </div>
  );
};
