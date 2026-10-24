import { UnitType } from './types';

// Generates authentic SVG Bundeswehr shoulder rank insignia (Schulterklappen)
// both as inline HTML strings for UI panels and as preloaded Image objects for Canvas rendering.

const svgCache: Partial<Record<UnitType, string>> = {};
const imgCache: Partial<Record<UnitType, HTMLImageElement>> = {};

function createPip(x: number, y: number, color: string, stroke: string, size = 5.2): string {
  // 4-pointed Bundeswehr rhomb star (Rangstern) with inner detail
  return `
    <g transform="translate(${x}, ${y})">
      <polygon points="0,-${size} ${size},0 0,${size} -${size},0" fill="${color}" stroke="${stroke}" stroke-width="0.9"/>
      <circle cx="0" cy="0" r="${size * 0.35}" fill="none" stroke="${stroke}" stroke-width="0.6"/>
    </g>
  `;
}

function createOakWreath(y: number, color: string, stroke: string): string {
  // Eichenlaubkranz at bottom of Stabsoffizier / General shoulder board
  return `
    <g transform="translate(20, ${y})">
      <path d="M -11,-4 C -12,4 -6,8 0,8 C 6,8 12,4 11,-4" fill="none" stroke="${stroke}" stroke-width="4.2" stroke-linecap="round"/>
      <path d="M -11,-4 C -12,4 -6,8 0,8 C 6,8 12,4 11,-4" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="3,1.2"/>
      <rect x="-2.5" y="6" width="5" height="2.6" rx="1" fill="${color}" stroke="${stroke}" stroke-width="0.6"/>
    </g>
  `;
}

export function getInsigniaSVG(type: UnitType): string {
  if (svgCache[type]) return svgCache[type]!;

  // Base Bundeswehr shoulder board (Schulterklappe) 40x56 viewBox
  const gold = '#fbbf24';
  const goldStroke = '#78350f';
  const silver = '#e2e8f0';
  const silverStroke = '#0f172a';
  const cloth = '#3f4a3c'; // Feldgrau / Steingrau-Oliv
  const clothDark = '#273025';

  let inner = '';

  const baseBoard = (borderColor = '#1e293b', borderWidth = 1.5) => `
    <path d="M 6,52 L 6,14 L 13,5 L 27,5 L 34,14 L 34,52 Z" fill="${cloth}" stroke="${borderColor}" stroke-width="${borderWidth}" stroke-linejoin="round"/>
    <circle cx="20" cy="10.5" r="2.2" fill="#94a3b8" stroke="#1e293b" stroke-width="0.8"/>
  `;

  switch (type) {
    case 'marshal': {
      // Rang 10: General (4 goldene Sterne + goldenes Eichenlaub + goldene Randkordel)
      inner = `
        ${baseBoard(gold, 2.2)}
        ${createOakWreath(42, gold, goldStroke)}
        ${createPip(20, 17, gold, goldStroke, 4.3)}
        ${createPip(20, 24.5, gold, goldStroke, 4.3)}
        ${createPip(20, 32, gold, goldStroke, 4.3)}
        ${createPip(20, 39.5, gold, goldStroke, 4.3)}
      `;
      break;
    }
    case 'general': {
      // Rang 9: Generalleutnant (3 goldene Sterne + goldenes Eichenlaub + goldene Randkordel)
      inner = `
        ${baseBoard(gold, 2.2)}
        ${createOakWreath(42, gold, goldStroke)}
        ${createPip(20, 18.5, gold, goldStroke, 4.6)}
        ${createPip(20, 27.5, gold, goldStroke, 4.6)}
        ${createPip(20, 36.5, gold, goldStroke, 4.6)}
      `;
      break;
    }
    case 'colonel': {
      // Rang 8: Oberst (3 silberne Sterne + silbernes Eichenlaub)
      inner = `
        ${baseBoard(silver, 1.6)}
        ${createOakWreath(42, silver, silverStroke)}
        ${createPip(20, 18.5, silver, silverStroke, 4.6)}
        ${createPip(20, 27.5, silver, silverStroke, 4.6)}
        ${createPip(20, 36.5, silver, silverStroke, 4.6)}
      `;
      break;
    }
    case 'major': {
      // Rang 7: Major (1 silberner Stern + silbernes Eichenlaub)
      inner = `
        ${baseBoard(silver, 1.6)}
        ${createOakWreath(41, silver, silverStroke)}
        ${createPip(20, 27, silver, silverStroke, 5.4)}
      `;
      break;
    }
    case 'captain': {
      // Rang 6: Hauptmann (3 silberne Sterne)
      inner = `
        ${baseBoard()}
        ${createPip(20, 20, silver, silverStroke, 5)}
        ${createPip(20, 31, silver, silverStroke, 5)}
        ${createPip(20, 42, silver, silverStroke, 5)}
      `;
      break;
    }
    case 'lieutenant': {
      // Rang 5: Leutnant (1 silberner Stern)
      inner = `
        ${baseBoard()}
        ${createPip(20, 32, silver, silverStroke, 5.8)}
      `;
      break;
    }
    case 'sergeant': {
      // Rang 4: Feldwebel (Unten geschlossene Tresse + Winkel darüber)
      inner = `
        ${baseBoard()}
        <!-- U-förmige Unteroffizierstresse -->
        <path d="M 9,20 L 9,48 L 31,48 L 31,20" fill="none" stroke="${silver}" stroke-width="3.2" stroke-linejoin="miter"/>
        <!-- Feldwebel-Winkel -->
        <path d="M 11,34 L 20,25 L 29,34" fill="none" stroke="${silver}" stroke-width="3.2" stroke-linecap="square" stroke-linejoin="miter"/>
      `;
      break;
    }
    case 'miner': {
      // Rang 3: Stabsgefreiter / Pionier (3 Schrägbalken + gekreuztes Pionier-Symbol)
      inner = `
        ${baseBoard()}
        <line x1="8" y1="47" x2="32" y2="39" stroke="${silver}" stroke-width="3"/>
        <line x1="8" y1="40" x2="32" y2="32" stroke="${silver}" stroke-width="3"/>
        <line x1="8" y1="33" x2="32" y2="25" stroke="${silver}" stroke-width="3"/>
        <!-- Kleines Pionier-Zahnrad/Pickel oben -->
        <circle cx="20" cy="20" r="3.5" fill="none" stroke="${gold}" stroke-width="1.6" stroke-dasharray="2,1"/>
      `;
      break;
    }
    case 'scout': {
      // Rang 2: Obergefreiter / Aufklärer (2 Schrägbalken + goldener Aufklärer-Blitz/Fadenkreuz)
      inner = `
        ${baseBoard()}
        <line x1="8" y1="46" x2="32" y2="38" stroke="${silver}" stroke-width="3.2"/>
        <line x1="8" y1="38" x2="32" y2="30" stroke="${silver}" stroke-width="3.2"/>
        <circle cx="20" cy="21" r="4" fill="none" stroke="${gold}" stroke-width="1.4"/>
        <line x1="14" y1="21" x2="26" y2="21" stroke="${gold}" stroke-width="1.2"/>
        <line x1="20" y1="15" x2="20" y2="27" stroke="${gold}" stroke-width="1.2"/>
      `;
      break;
    }
    case 'spy': {
      // Rang 1: Gefreiter / Kommando-Spion (1 Schrägbalken + Dolch-Abzeichen)
      inner = `
        ${baseBoard()}
        <line x1="8" y1="45" x2="32" y2="37" stroke="${silver}" stroke-width="3.4"/>
        <polygon points="20,15 22.5,27 20,29 17.5,27" fill="${silver}" stroke="${silverStroke}" stroke-width="0.7"/>
        <line x1="16" y1="26" x2="24" y2="26" stroke="${gold}" stroke-width="1.8"/>
      `;
      break;
    }
    case 'bomb': {
      // Landmine / Bombe
      inner = `
        <circle cx="20" cy="31" r="13" fill="#1e293b" stroke="#94a3b8" stroke-width="2"/>
        <circle cx="20" cy="31" r="7" fill="#ef4444" stroke="#fca5a5" stroke-width="1.2"/>
        <path d="M 20,18 L 20,11 Q 25,8 29,12" fill="none" stroke="#fbbf24" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="29" cy="12" r="2.5" fill="#f59e0b"/>
      `;
      break;
    }
    case 'flag': {
      // Bundesdienstflagge / Kommandoflagge
      inner = `
        <line x1="10" y1="8" x2="10" y2="50" stroke="#e2e8f0" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="11.5" y="10" width="22" height="6" fill="#111827"/>
        <rect x="11.5" y="16" width="22" height="6" fill="#dc2626"/>
        <rect x="11.5" y="22" width="22" height="6" fill="#fbbf24"/>
        <rect x="11.5" y="10" width="22" height="18" fill="none" stroke="#f8fafc" stroke-width="0.8"/>
        <circle cx="22.5" cy="19" r="3.5" fill="#fbbf24" stroke="#111827" stroke-width="0.8"/>
      `;
      break;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 56" width="100%" height="100%">${inner}</svg>`;
  svgCache[type] = svg;
  return svg;
}

export function getInsigniaImage(type: UnitType, onLoad?: () => void): HTMLImageElement {
  if (imgCache[type]) return imgCache[type]!;

  const svg = getInsigniaSVG(type);
  const img = new Image();
  const encoded = encodeURIComponent(svg);
  img.src = `data:image/svg+xml;utf8,${encoded}`;
  if (onLoad) {
    img.onload = onLoad;
  }
  imgCache[type] = img;
  return img;
}
