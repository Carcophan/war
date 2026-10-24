export type Faction = 'player' | 'ai';

export type AIDifficulty = 'normal' | 'hard' | 'ultra';

export type GameMode = 'classic' | 'scouts_only';

export type TerrainType = 'grass' | 'forest' | 'water' | 'mountain';

export type UnitType =
  | 'flag'
  | 'bomb'
  | 'spy'
  | 'scout'
  | 'miner'
  | 'sergeant'
  | 'lieutenant'
  | 'captain'
  | 'major'
  | 'colonel'
  | 'general'
  | 'marshal';

export interface UnitDefinition {
  type: UnitType;
  name: string;
  shortName: string;
  rank: number; // 0 for flag, 11 for bomb, 1-10 for combat units
  count: number;
  canMove: boolean;
  maxMoveRange: number; // 1 for normal, 3 for scout along straight hex lines
  icon: string;
  description: string;
}

export interface Unit {
  id: string;
  type: UnitType;
  faction: Faction;
  q: number;
  r: number;
  revealed: boolean; // Has the enemy seen this unit's rank?
  hasMovedEver: boolean; // Useful for AI deduction (unmoved units might be bombs/flag)
  xp?: number; // Experience / level-up progress in scouts_only mode
}

export interface HexTile {
  q: number;
  r: number;
  terrain: TerrainType;
}

export type GamePhase = 'setup' | 'player_turn' | 'animating_move' | 'combat_anim' | 'ai_turn' | 'game_over';

export interface MoveAnimation {
  unit: Unit;
  fromQ: number;
  fromR: number;
  toQ: number;
  toR: number;
  startTime: number;
  duration: number;
  // Optional second unit for setup swap animation
  swapUnit?: Unit;
  // Optional pixel offset from center when settling after a drag-drop
  customStartOffset?: { fromX: number; fromY: number };
}

export interface CombatEvent {
  attacker: Unit;
  defender: Unit;
  winner: 'attacker' | 'defender' | 'both_die';
  fromQ: number;
  fromR: number;
  toQ: number;
  toR: number;
  reason: string;
  timestamp: number;
}

export interface LogEntry {
  id: number;
  turn: number;
  faction: Faction | 'system';
  message: string;
  isCombat?: boolean;
}

export const UNIT_DEFINITIONS: Record<UnitType, UnitDefinition> = {
  marshal: {
    type: 'marshal',
    name: 'General (4★)',
    shortName: 'GEN',
    rank: 10,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '⭐⭐⭐⭐',
    description: 'Höchster Bundeswehr-Dienstgrad (Rang 10: 4 goldene Sterne mit goldenem Eichenlaub). Besiegt jede bewegliche Einheit, kann aber vom Spion geschlagen werden, wenn der Spion zuerst angreift.'
  },
  general: {
    type: 'general',
    name: 'Generalleutnant (3★)',
    shortName: 'GLT',
    rank: 9,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '⭐⭐⭐',
    description: 'Zweithöchster Rang (9: 3 goldene Sterne mit goldenem Eichenlaub). Sehr stark im Angriff und in der Verteidigung.'
  },
  colonel: {
    type: 'colonel',
    name: 'Oberst',
    shortName: 'OB',
    rank: 8,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '✦✦✦',
    description: 'Stabsoffizier (Rang 8: 3 silberne Sterne mit silbernem Eichenlaub). Führt die Frontlinie an.'
  },
  major: {
    type: 'major',
    name: 'Major',
    shortName: 'MAJ',
    rank: 7,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '✦',
    description: 'Stabsoffizier (Rang 7: 1 silberner Stern mit silbernem Eichenlaub).'
  },
  captain: {
    type: 'captain',
    name: 'Hauptmann',
    shortName: 'HPT',
    rank: 6,
    count: 2,
    canMove: true,
    maxMoveRange: 1,
    icon: '◇◇◇',
    description: 'Offizier (Rang 6: 3 silberne Sterne ohne Eichenlaub).'
  },
  lieutenant: {
    type: 'lieutenant',
    name: 'Leutnant',
    shortName: 'LT',
    rank: 5,
    count: 2,
    canMove: true,
    maxMoveRange: 1,
    icon: '◇',
    description: 'Zugführer (Rang 5: 1 silberner Stern).'
  },
  sergeant: {
    type: 'sergeant',
    name: 'Feldwebel',
    shortName: 'FW',
    rank: 4,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '⋀',
    description: 'Unteroffizier mit Portepee (Rang 4: Silberne Tresse mit Feldwebel-Winkel).'
  },
  miner: {
    type: 'miner',
    name: 'Pionier (StGefr)',
    shortName: 'PIO',
    rank: 3,
    count: 3,
    canMove: true,
    maxMoveRange: 1,
    icon: '///',
    description: 'Kampfmittelbeseitiger / Stabsgefreiter (Rang 3: 3 Schrägbalken). Die EINZIGE Einheit, die feindliche Bomben/Minen entschärfen kann!'
  },
  scout: {
    type: 'scout',
    name: 'Aufklärer (OGefr)',
    shortName: 'AUF',
    rank: 2,
    count: 2,
    canMove: true,
    maxMoveRange: 4,
    icon: '//',
    description: 'Spähtrupp / Obergefreiter (Rang 2: 2 Schrägbalken). Kann bis zu 4 Hex-Felder weit in einer geraden Linie ziehen und angreifen!'
  },
  spy: {
    type: 'spy',
    name: 'Spion (Gefr)',
    shortName: 'SPY',
    rank: 1,
    count: 1,
    canMove: true,
    maxMoveRange: 1,
    icon: '/',
    description: 'Kommando-Spion / Gefreiter (Rang 1: 1 Schrägbalken). Verliert gegen alle Einheiten, ABER besiegt den 4-Sterne-General (10), wenn der Spion selbst angreift!'
  },
  bomb: {
    type: 'bomb',
    name: 'Landmine / Bombe',
    shortName: 'BMB',
    rank: 11,
    count: 3,
    canMove: false,
    maxMoveRange: 0,
    icon: '💣',
    description: 'Unbeweglich. Vernichtet jeden Angreifer sofort (und bleibt selbst bestehen), außer sie wird von einem Pionier (Rang 3) entschärft!'
  },
  flag: {
    type: 'flag',
    name: 'Kommandoflagge',
    shortName: 'FLG',
    rank: 0,
    count: 1,
    canMove: false,
    maxMoveRange: 0,
    icon: '🚩',
    description: 'Unbeweglich. Der Gefechtsstand deiner Armee! Wer die feindliche Kommandoflagge erobert, gewinnt sofort das Spiel.'
  }
};

export const ORDERED_UNIT_TYPES: UnitType[] = [
  'marshal',
  'general',
  'colonel',
  'major',
  'captain',
  'lieutenant',
  'sergeant',
  'miner',
  'scout',
  'spy',
  'bomb',
  'flag'
];

export const PROMOTION_CHAIN: UnitType[] = [
  'scout',
  'miner',
  'sergeant',
  'lieutenant',
  'captain',
  'major',
  'colonel',
  'general',
  'marshal'
];

export const SCOUTS_ONLY_INITIAL_COUNTS: Record<UnitType, number> = {
  marshal: 0,
  general: 0,
  colonel: 0,
  major: 0,
  captain: 0,
  lieutenant: 0,
  sergeant: 0,
  miner: 0,
  scout: 18,
  spy: 0,
  bomb: 3,
  flag: 1
};

export function getInitialUnitCount(type: UnitType, mode: GameMode): number {
  if (mode === 'scouts_only') {
    return SCOUTS_ONLY_INITIAL_COUNTS[type];
  }
  return UNIT_DEFINITIONS[type].count;
}

