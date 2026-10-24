// Axial hex coordinate utilities (Pointy-Top Hexagons)

export interface AxialCoord {
  q: number;
  r: number;
}

export const HEX_DIRECTIONS: AxialCoord[] = [
  { q: 1, r: 0 },   // East
  { q: 1, r: -1 },  // North-East
  { q: 0, r: -1 },  // North-West
  { q: -1, r: 0 },  // West
  { q: -1, r: 1 },  // South-West
  { q: 0, r: 1 }    // South-East
];

export function coordKey(q: number, r: number): string {
  return `${q},${r}`;
}

export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

export function getNeighbors(q: number, r: number): AxialCoord[] {
  return HEX_DIRECTIONS.map(d => ({ q: q + d.q, r: r + d.r }));
}

// Convert axial (q, r) to pixel (x, y) for pointy-top hexes
export function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * (3 / 2) * r;
  return { x, y };
}

// Convert pixel (x, y) relative to grid center to axial (q, r)
export function pixelToAxial(x: number, y: number, size: number): AxialCoord {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return axialRound(q, r);
}

function axialRound(q: number, r: number): AxialCoord {
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}
