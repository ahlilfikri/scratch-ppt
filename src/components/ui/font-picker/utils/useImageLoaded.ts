import { useEffect, useState } from "react";

export function useImageLoaded(src: string) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!src) {
      return;
    }

    const image = new Image();
    image.src = src;

    const handleLoad = () => setLoaded(true);
    const handleError = () => setLoaded(false);

    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);

    return () => {
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
    };
  }, [src]);

  return loaded;
}
