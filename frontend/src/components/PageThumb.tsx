import { memo, useState } from "react";
import { thumbUrl } from "../api/client";

export interface ThumbSource {
  source_id: string;
  index: number;
  rotation: number;
  width: number;
  height: number;
}

/** Size of the page as displayed (after our extra rotation). */
export function displayedAspect(page: ThumbSource): number {
  const quarter = page.rotation % 180 !== 0;
  const w = quarter ? page.height : page.width;
  const h = quarter ? page.width : page.height;
  return w / h;
}

function snapWidth(px: number): number {
  if (px <= 200) return 200;
  if (px <= 400) return 400;
  return 800;
}

interface Props {
  page: ThumbSource;
  /** Box the page is fitted into, in CSS pixels. */
  boxWidth: number;
  boxHeight: number;
  className?: string;
  eager?: boolean;
  alt?: string;
}

/**
 * A page thumbnail fitted inside a box. Thumbnails are rendered unrotated by the server
 * (their URLs never change), and the page's extra rotation is applied with CSS.
 */
export const PageThumb = memo(function PageThumb({ page, boxWidth, boxHeight, className, eager, alt = "" }: Props) {
  const [failed, setFailed] = useState(false);
  const aspect = displayedAspect(page);
  let dw = boxWidth;
  let dh = boxWidth / aspect;
  if (dh > boxHeight) {
    dh = boxHeight;
    dw = boxHeight * aspect;
  }
  const quarter = page.rotation % 180 !== 0;
  const imgW = quarter ? dh : dw;
  const imgH = quarter ? dw : dh;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const src = thumbUrl(page.source_id, page.index, snapWidth(imgW * dpr));
  return (
    <div className={`thumb-box ${className ?? ""}`} style={{ width: boxWidth, height: boxHeight }}>
      <div className="thumb-paper" style={{ width: dw, height: dh }}>
        {!failed && (
          <img
            src={src}
            alt={alt}
            draggable={false}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            onError={() => setFailed(true)}
            style={{
              width: imgW,
              height: imgH,
              transform: `translate(-50%, -50%) rotate(${page.rotation}deg)`,
            }}
          />
        )}
      </div>
    </div>
  );
});
