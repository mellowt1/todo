// Draws the app icon (the check circle from the design, sage on a neutral ground) and writes the PNGs.
//   npm run icons
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';

const SAGE = '#3F7D5C';
const GROUND = '#F5F5F7';

// glyph: share of the icon the 24px glyph box takes (design: 112 of 180).
function svg(size, glyph) {
  const g = size * glyph;
  const off = (size - g) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${GROUND}"/>
  <g transform="translate(${off} ${off}) scale(${g / 24})" fill="none" stroke="${SAGE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M8 12.3l2.8 2.8L16.2 9.5"/>
  </g>
</svg>`;
}

const out = new URL('../app/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const jobs = [
  ['icon-180.png', 180, 112 / 180],
  ['icon-192.png', 192, 112 / 180],
  ['icon-512.png', 512, 112 / 180],
  // Maskable: the circle stays inside the 80% safe zone, with room to spare.
  ['icon-512-maskable.png', 512, 0.5],
];
for (const [name, size, glyph] of jobs) {
  const png = new Resvg(svg(size, glyph)).render().asPng();
  writeFileSync(new URL(name, out), png);
  console.log(name, png.length, 'bytes');
}
writeFileSync(new URL('icon.svg', out), svg(512, 112 / 180));
