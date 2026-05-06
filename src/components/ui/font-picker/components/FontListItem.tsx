import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useImageLoaded } from "../utils/useImageLoaded";

import { Button } from "@/components/ui/button";
import { type Font } from "../types";
import { getSpriteNumber } from "../utils/utils";

export const FontListItem = ({
  font,
  isCurrent,
  onSelect,
  fontIndex,
}: {
  font: Font;
  isCurrent: boolean;
  onSelect: () => void;
  fontIndex: number;
}) => {
  const spriteNumber = getSpriteNumber(fontIndex);
  const isSpriteLoaded = useImageLoaded(
    `/font-preview/sprite.${spriteNumber}.svg`,
  );

  return (
    <Button
      key={font.sane}
      variant={isCurrent ? "secondary" : "ghost"}
      className="h-auto w-full justify-start p-2"
      onClick={onSelect}
    >
      <div
        className={cn(
          "flex w-full items-center rounded-sm px-1 py-2 transition-colors",
          isCurrent && "bg-accent",
        )}
      >
        {isSpriteLoaded ? (
          <div
            className={`font-preview-${font.sane} w-full`}
            title={font.name}
          />
        ) : (
          <span>{font.name}</span>
        )}
        {isCurrent && <Check className="ml-auto h-4 w-4" />}
      </div>
    </Button>
  );
};
