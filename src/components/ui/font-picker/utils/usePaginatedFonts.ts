import { useCallback, useEffect, useMemo, useState } from "react";
import { type Font } from "../types";
// Hook for paginated font loading with virtual scrolling
export function usePaginatedFonts(
  fonts: Font[],
  searchValue: string,
  chunkSize: number = 50,
) {
  const [visibleCount, setVisibleCount] = useState(chunkSize);
  const [isLoadingMore, setIsLoadingMore] = useState(false); // Filter fonts based on search - immediate, no debounce

  const filteredFonts = useMemo(() => {
    if (!searchValue.trim()) return fonts;
    const searchTerm = searchValue.toLowerCase();
    return fonts.filter((font) => font.name.toLowerCase().includes(searchTerm));
  }, [fonts, searchValue]); // Get visible fonts (paginated)

  const visibleFonts = useMemo(() => {
    return filteredFonts.slice(0, visibleCount);
  }, [filteredFonts, visibleCount]); // Load more fonts

  const loadMore = useCallback(() => {
    if (isLoadingMore || visibleCount >= filteredFonts.length) return;

    setIsLoadingMore(true); // Small delay to prevent too many rapid calls
    setTimeout(() => {
      setVisibleCount((prev) =>
        Math.min(prev + chunkSize, filteredFonts.length),
      );
      setIsLoadingMore(false);
    }, 100);
  }, [isLoadingMore, visibleCount, filteredFonts.length, chunkSize]); // Reset visible count when search changes

  useEffect(() => {
    setVisibleCount(chunkSize);
  }, [searchValue, chunkSize]);

  const hasMore = visibleCount < filteredFonts.length;

  return {
    visibleFonts,
    hasMore,
    isLoadingMore,
    loadMore,
    totalCount: filteredFonts.length,
  };
}
