/** biome-ignore-all lint/suspicious/noExplicitAny: This use requires any */
import { useCallback, useState } from "react";

// Hook for dynamic font info loading
export function useFontInfo() {
  const [fontInfos, setFontInfos] = useState<any[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFontInfo = useCallback(async () => {
    if (fontInfos || isLoading) return; // Already loaded or loading

    setIsLoading(true);
    setError(null);

    try {
      // Dynamic import of the large JSON file
      const fontInfoModule = await import("../font-preview/fontInfo.json");
      setFontInfos(fontInfoModule.default);
    } catch (err) {
      console.error("Failed to load font info:", err);
      setError("Failed to load fonts");
    } finally {
      setIsLoading(false);
    }
  }, [fontInfos, isLoading]);

  return { fontInfos, isLoading, error, loadFontInfo };
}
