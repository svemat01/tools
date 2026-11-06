import type { ImageReview } from "./image-tune.ts";

/** JSON is inert text; user values are only assigned via DOM text/properties. */
export function renderImageReview(review: ImageReview): string {
  const data = JSON.stringify(review).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>sv image review</title><style>
*{box-sizing:border-box}body{margin:0;background:#111820;color:#e8eef5;font:16px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:24px}h1{font-size:1.7rem;overflow-wrap:anywhere;margin:0}p{color:#b4c5d4}.controls{display:flex;flex-wrap:wrap;gap:16px;align-items:end;padding:18px 0}label{display:grid;gap:5px}select,a{font:inherit;background:#233548;color:#fff;padding:9px;border:1px solid #7491aa;border-radius:6px}a{text-decoration:none}input{accent-color:#7cd8cb}input[type=range]{width:200px}select:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #7cd8cb;outline-offset:3px}.viewport{overflow:auto;max-height:70vh;border:1px solid #7491aa;background:repeating-conic-gradient(#25313b 0% 25%,#19232c 0% 50%) 0/20px 20px}.stage{position:relative;isolation:isolate;line-height:0}.stage img{display:block;width:100%;height:100%;background:repeating-conic-gradient(#25313b 0% 25%,#19232c 0% 50%) 0/20px 20px}#encoded{position:absolute;inset:0;clip-path:inset(0 0 0 50%)}#line{position:absolute;top:0;bottom:0;left:50%;width:4px;transform:translateX(-2px);background:#7cd8cb;cursor:ew-resize;touch-action:none}#line:after{content:'↔';position:absolute;top:40%;left:-15px;width:34px;height:34px;line-height:32px;border-radius:50%;background:#7cd8cb;color:#111;text-align:center}.legend{display:flex;justify-content:space-between;gap:12px;margin:8px 0;font-weight:600}#stats{font-variant-numeric:tabular-nums;white-space:pre-line;background:#1c2936;padding:14px;border-radius:8px}small{color:#b4c5d4}@media(max-width:600px){main{padding:14px}.controls>*{flex:1}input[type=range]{width:100%}.legend{font-size:.85rem}}
</style></head><body><main><h1 id="title">Image review</h1><p id="source"></p>
<div class="controls"><label>Encoded quality<select id="quality"></select></label><label>Zoom<select id="zoom"><option value="fit">Fit width</option><option value="1">100% · output pixels</option><option value="2">200%</option><option value="4">400%</option></select></label><label>Comparison divider<input id="divider" type="range" min="0" max="100" value="50" aria-label="Original to encoded comparison divider"></label><a id="download">Download selected variant</a></div>
<div id="stats" role="status" aria-live="polite"></div><p id="image-status" role="status" aria-live="polite"></p><div class="legend"><span>Left: source at output size</span><span>Right: encoded variant</span></div>
<div class="viewport" id="viewport" tabindex="0" aria-label="Aligned image comparison. Scroll to pan when zoomed."><div class="stage" id="stage"><img id="original" alt="Source reference, oriented and resized to output dimensions"><img id="encoded" alt="Selected encoded variant"><div id="line" aria-hidden="true"></div></div></div>
<p>Drag the divider or use its slider with arrow keys. Both images share one pixel grid. Zoom, then scroll to pan; on touch screens, swipe to pan.</p><small>The reference is an oriented PNG resized to the output dimensions, without source metadata. Savings compare encoded bytes with the source file, including any resize. The reference is for comparison; downloads contain only the selected encoded image. Everything works offline.</small><noscript><p>Enable JavaScript to compare and download embedded variants.</p></noscript>
<script id="review-data" type="application/json">${data}</script><script>
"use strict";
const review=JSON.parse(document.getElementById('review-data').textContent);
const el=id=>document.getElementById(id);
const bytes=n=>n.toLocaleString()+' bytes';
el('title').textContent=review.filename;
el('source').textContent='Source: '+review.source.format.toUpperCase()+' · '+review.source.width+' × '+review.source.height+' · '+bytes(review.source.bytes);
for(const [i,v] of review.variants.entries()){const option=document.createElement('option');option.value=String(i);option.textContent=v.format.toUpperCase()+' · quality '+v.quality+' · '+bytes(v.bytes);el('quality').append(option);}
// Only generated image data URLs are allowed, even if a report is edited later.
const imageURL=url=>/^data:image\/(png|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(url)?url:'';
let sourceFailed=false;
const imageStatus=()=>{el('image-status').textContent=sourceFailed?'The source reference could not be displayed. Try regenerating this report.':'';};
el('original').addEventListener('error',()=>{sourceFailed=true;imageStatus();});
el('encoded').addEventListener('error',()=>{el('image-status').textContent='This browser could not display the selected image. Try a WebP report or a browser that supports this format; the encoded download is still available.';});
el('encoded').addEventListener('load',imageStatus);
el('original').src=imageURL(review.reference.url);
// Begin with the middle candidate; every quality remains selectable.
el('quality').value=String(Math.floor((review.variants.length-1)/2));
function select(){imageStatus();const v=review.variants[Number(el('quality').value)];el('encoded').src=imageURL(v.url);el('download').href=imageURL(v.url);el('download').download=v.filename;el('stats').textContent='Encoded: '+v.format.toUpperCase()+' · quality '+v.quality+' · '+v.width+' × '+v.height+' · '+bytes(v.bytes)+'\n'+v.savings.toFixed(1)+'% savings vs source ('+bytes(review.source.bytes)+')';}
function size(){const factor=el('zoom').value;const width=factor==='fit'?Math.min(el('viewport').clientWidth,review.reference.width):review.reference.width*Number(factor);el('stage').style.imageRendering=factor==='fit'?'auto':'pixelated';el('stage').style.width=width+'px';el('stage').style.height=width*review.reference.height/review.reference.width+'px';}
function divide(){const percent=Number(el('divider').value);el('encoded').style.clipPath='inset(0 0 0 '+percent+'%)';el('line').style.left=percent+'%';}
el('quality').addEventListener('change',select);el('zoom').addEventListener('change',size);el('divider').addEventListener('input',divide);window.addEventListener('resize',size);
el('line').addEventListener('pointerdown',e=>{el('line').setPointerCapture(e.pointerId);e.preventDefault();});
el('line').addEventListener('pointermove',e=>{if(!el('line').hasPointerCapture(e.pointerId))return;const box=el('stage').getBoundingClientRect();el('divider').value=String(Math.max(0,Math.min(100,100*(e.clientX-box.left)/box.width)));divide();});
select();size();divide();
</script></main></body></html>`;
}
