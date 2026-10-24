import { AxialCoord, coordKey, HEX_DIRECTIONS, hexDistance } from './hex';
import {
  AIDifficulty,
  CombatEvent,
  Faction,
  GameMode,
  GamePhase,
  getInitialUnitCount,
  HexTile,
  LogEntry,
  MoveAnimation,
  ORDERED_UNIT_TYPES,
  PROMOTION_CHAIN,
  TerrainType,
  Unit,
  UNIT_DEFINITIONS,
  UnitType
} from './types';
import { sound } from './audio';
import { AISearchStats, StrategoAIEngine } from './ai';
import { AIMultiCorePool } from './ai-pool';

export interface GameScoreSummary {
  playerTotalScore: number;
  aiTotalScore: number;
  playerArmyScore: number;
  aiArmyScore: number;
  playerKillPoints: number;
  aiKillPoints: number;
  playerKills: number;
  aiKills: number;
  playerUnitsAlive: number;
  aiUnitsAlive: number;
  evalForPlayer: number; // +1.85 means Blue ahead by 1.85 units, -1.50 means AI ahead
  playerWinProb: number; // 0..100%
  matchWinsPlayer: number;
  matchWinsAI: number;
}

const MATCH_SCORE_STORAGE_KEY = 'hex_stratego_match_score_v1';

export class HexStrategoGame {
  public readonly radius = 4;
  public tiles: Map<string, HexTile> = new Map();
  public units: Unit[] = [];
  public phase: GamePhase = 'setup';
  public gameMode: GameMode = 'classic';
  public turn = 1;
  public winner: Faction | null = null;
  public winReason = '';
  public logs: LogEntry[] = [];
  private nextLogId = 1;

  public playerKills = 0;
  public aiKills = 0;
  public playerKillPoints = 0;
  public aiKillPoints = 0;
  public matchWinsPlayer = 0;
  public matchWinsAI = 0;

  public selectedUnitId: string | null = null;
  public selectedSetupType: UnitType | null = 'flag';
  public lastMove: { fromQ: number; fromR: number; toQ: number; toR: number } | null = null;
  public activeCombat: CombatEvent | null = null;
  public activeMoveAnim: MoveAnimation | null = null;
  public aiDifficulty: AIDifficulty = 'ultra';
  public debugRevealAI = false;

  private aiEngine = new StrategoAIEngine();
  private aiPool: AIMultiCorePool;
  private gameId = 1;
  private onChangeCallback: () => void;
  private onTelemetryCallback: (() => void) | null = null;

  constructor(onChange: () => void, onTelemetry?: () => void) {
    this.onChangeCallback = onChange;
    this.onTelemetryCallback = onTelemetry || null;
    this.aiPool = new AIMultiCorePool(this.aiEngine, () => {
      if (this.onTelemetryCallback) {
        this.onTelemetryCallback();
      }
    });
    this.loadMatchScore();
  }

  public setTelemetryCallback(cb: () => void): void {
    this.onTelemetryCallback = cb;
    this.aiPool.setTelemetryCallback(cb);
  }

  public getAIWorkerCount(): number {
    return this.aiPool.workerCount;
  }

  public syncAI(): void {
    this.aiPool.syncState(
      this.units,
      this.tiles,
      this.phase,
      this.turn,
      this.aiDifficulty,
      this.gameMode
    );
  }

  private loadMatchScore(): void {
    try {
      const raw = localStorage.getItem(MATCH_SCORE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.matchWinsPlayer = Number(parsed.player) || 0;
        this.matchWinsAI = Number(parsed.ai) || 0;
      }
    } catch {
      // Ignore storage errors
    }
  }

  private saveMatchScore(): void {
    try {
      localStorage.setItem(
        MATCH_SCORE_STORAGE_KEY,
        JSON.stringify({ player: this.matchWinsPlayer, ai: this.matchWinsAI })
      );
    } catch {
      // Ignore storage errors
    }
  }

  public initNewGame(playAudio = false): void {
    this.gameId++;
    this.tiles.clear();
    this.units = [];
    this.phase = 'setup';
    this.turn = 1;
    this.winner = null;
    this.winReason = '';
    this.logs = [];
    this.playerKills = 0;
    this.aiKills = 0;
    this.playerKillPoints = 0;
    this.aiKillPoints = 0;
    this.selectedUnitId = null;
    this.selectedSetupType = 'flag';
    this.lastMove = null;
    this.activeCombat = null;
    this.activeMoveAnim = null;
    this.aiPool.reset();

    this.generateBoard();
    this.autoDeployPlayer(playAudio);
    this.deployAI();

    if (this.gameMode === 'scouts_only') {
      this.addLog(
        'system',
        'Modus "Spähtrupp-Karriere": Nur Kommandoflagge, 3 Bomben & 18 Aufklärer! Aufklärer steigen im Rang auf (2 EP durch Vorrücken/Waldfelder oder sofort durch Kampfsieg).'
      );
    } else {
      this.addLog(
        'system',
        'Aufstellungsphase: Klicke auf zwei deiner blauen Einheiten (untere 3 Reihen), um ihre Plätze zu tauschen, oder wähle "Zufällig" / "Schlacht starten"!'
      );
    }
    this.notify();
  }

  private generateBoard(): void {
    // Radius 4 pointy-top hex board (61 tiles)
    // r in [-4, 4]
    // r <= -2: AI deployment zone (22 tiles)
    // r >= 2: Player deployment zone (22 tiles)
    // r in [-1, 1]: Neutral frontline (24 tiles), with strategic lakes/mountains as chokepoints
    const blockedCoords = new Set<string>([
      coordKey(-2, 0),
      coordKey(2, 0),
      coordKey(0, 0)
    ]);

    const forestCoords = new Set<string>([
      coordKey(-3, 1),
      coordKey(2, -1),
      coordKey(-1, 1),
      coordKey(1, -1),
      coordKey(-1, -2),
      coordKey(1, 2)
    ]);

    for (let q = -this.radius; q <= this.radius; q++) {
      const r1 = Math.max(-this.radius, -q - this.radius);
      const r2 = Math.min(this.radius, -q + this.radius);
      for (let r = r1; r <= r2; r++) {
        const key = coordKey(q, r);
        let terrain: TerrainType = 'grass';
        if (blockedCoords.has(key)) {
          terrain = q === 0 && r === 0 ? 'mountain' : 'water';
        } else if (forestCoords.has(key)) {
          terrain = 'forest';
        }
        this.tiles.set(key, { q, r, terrain });
      }
    }
  }

  public getDeploymentCoords(faction: Faction): AxialCoord[] {
    const coords: AxialCoord[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.terrain === 'water' || tile.terrain === 'mountain') continue;
      if (faction === 'player' && tile.r >= 2) {
        coords.push({ q: tile.q, r: tile.r });
      } else if (faction === 'ai' && tile.r <= -2) {
        coords.push({ q: tile.q, r: tile.r });
      }
    }
    return coords;
  }

  public isDeploymentTile(faction: Faction, q: number, r: number): boolean {
    const tile = this.tiles.get(coordKey(q, r));
    if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') return false;
    return faction === 'player' ? r >= 2 : r <= -2;
  }

  private createArmyPool(): UnitType[] {
    const pool: UnitType[] = [];
    for (const type of ORDERED_UNIT_TYPES) {
      const count = getInitialUnitCount(type, this.gameMode);
      for (let i = 0; i < count; i++) {
        pool.push(type);
      }
    }
    return pool; // 22 units total
  }

  public setGameMode(mode: GameMode): void {
    if (this.gameMode === mode) return;
    this.gameMode = mode;
    this.initNewGame(true);
  }

  public autoDeployPlayer(playAudio = true): void {
    // Remove existing player units
    this.units = this.units.filter(u => u.faction !== 'player');
    const coords = this.getDeploymentCoords('player');
    this.smartDeployFaction('player', coords);
    this.selectedUnitId = null;
    if (playAudio) {
      sound.playMove();
    }
    this.notify();
  }

  public clearPlayerDeployment(): void {
    this.units = this.units.filter(u => u.faction !== 'player');
    this.selectedUnitId = null;
    this.selectedSetupType = 'flag';
    this.notify();
  }

  private deployAI(): void {
    this.units = this.units.filter(u => u.faction !== 'ai');
    const coords = this.getDeploymentCoords('ai');
    this.smartDeployFaction('ai', coords);
  }

  private smartDeployFaction(faction: Faction, availableCoords: AxialCoord[]): void {
    const placedUnits = this.aiEngine.deploySmartArmy(
      faction,
      availableCoords,
      this.tiles,
      this.gameMode
    );

    placedUnits.forEach((p, idx) => {
      this.units.push({
        id: `${faction}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        type: p.type,
        faction,
        q: p.q,
        r: p.r,
        revealed: false,
        hasMovedEver: false,
        xp: 0
      });
    });
  }

  public getUnplacedPlayerCounts(): Record<UnitType, number> {
    const counts = {} as Record<UnitType, number>;
    for (const type of ORDERED_UNIT_TYPES) {
      counts[type] = getInitialUnitCount(type, this.gameMode);
    }
    for (const u of this.units) {
      if (u.faction === 'player') {
        counts[u.type]--;
      }
    }
    return counts;
  }

  public isPlayerSetupComplete(): boolean {
    const playerUnits = this.units.filter(u => u.faction === 'player');
    const totalExpected = this.getDeploymentCoords('player').length;
    return playerUnits.length === totalExpected && totalExpected > 0;
  }

  public canPlayerDragUnit(unit: Unit): boolean {
    if (unit.faction !== 'player') return false;
    if (this.phase === 'setup') return true;
    if (this.phase === 'player_turn') {
      return UNIT_DEFINITIONS[unit.type].canMove;
    }
    return false;
  }

  public handleUnitDrop(
    unit: Unit,
    targetQ: number,
    targetR: number,
    animate = false,
    dropOffset?: { fromX: number; fromY: number }
  ): boolean {
    if (unit.q === targetQ && unit.r === targetR) return false;
    const tile = this.tiles.get(coordKey(targetQ, targetR));
    if (!tile) return false;

    if (this.phase === 'setup') {
      // Allow dragging a frontline unit forward into r < 2 to immediately start battle!
      if (targetR < 2 && this.isPlayerSetupComplete()) {
        const validMoves = this.getValidMoves(unit);
        if (validMoves.some(m => m.q === targetQ && m.r === targetR)) {
          this.startBattle();
          this.executeMove(unit, targetQ, targetR, animate, dropOffset);
          return true;
        }
      }

      if (this.isDeploymentTile('player', targetQ, targetR)) {
        const existingUnit = this.getUnitAt(targetQ, targetR);
        if (existingUnit && existingUnit.faction === 'player') {
          const fromQ = unit.q;
          const fromR = unit.r;
          unit.q = existingUnit.q;
          unit.r = existingUnit.r;
          existingUnit.q = fromQ;
          existingUnit.r = fromR;
          this.selectedUnitId = null;
          // Animate the swapped unit sliding back to the dragged unit's origin
          this.activeMoveAnim = {
            unit: existingUnit,
            fromQ: unit.q,
            fromR: unit.r,
            toQ: existingUnit.q,
            toR: existingUnit.r,
            startTime: performance.now(),
            duration: 220
          };
          sound.playMove();
          this.notify();
          return true;
        } else if (!existingUnit) {
          unit.q = targetQ;
          unit.r = targetR;
          this.selectedUnitId = null;
          sound.playMove();
          this.notify();
          return true;
        }
      }
      return false;
    }

    if (this.phase === 'player_turn') {
      const validMoves = this.getValidMoves(unit);
      if (validMoves.some(m => m.q === targetQ && m.r === targetR)) {
        this.executeMove(unit, targetQ, targetR, animate, dropOffset);
        return true;
      }
    }

    return false;
  }

  public handleTileClick(q: number, r: number): void {
    const tile = this.tiles.get(coordKey(q, r));
    if (!tile) return;

    // If a player unit in the frontline (r === 2) is clicked during setup and tried to move into r === 1, auto-start battle!
    if (this.phase === 'setup') {
      if (this.selectedUnitId && r < 2 && this.isPlayerSetupComplete()) {
        const selectedUnit = this.units.find(u => u.id === this.selectedUnitId);
        if (selectedUnit && selectedUnit.faction === 'player') {
          const validMoves = this.getValidMoves(selectedUnit);
          if (validMoves.some(m => m.q === q && m.r === r)) {
            this.startBattle();
            this.executeMove(selectedUnit, q, r);
            return;
          }
        }
      }
      this.handleSetupTileClick(q, r);
      return;
    }

    if (this.phase !== 'player_turn') return;

    const clickedUnit = this.getUnitAt(q, r);

    // If a player unit is currently selected, check if clicked tile is a valid move/attack
    if (this.selectedUnitId) {
      const selectedUnit = this.units.find(u => u.id === this.selectedUnitId);
      if (selectedUnit) {
        const validMoves = this.getValidMoves(selectedUnit);
        const isMoveTarget = validMoves.some(m => m.q === q && m.r === r);
        if (isMoveTarget) {
          this.executeMove(selectedUnit, q, r);
          return;
        }
      }
    }

    // Otherwise select own movable unit
    if (clickedUnit && clickedUnit.faction === 'player') {
      if (UNIT_DEFINITIONS[clickedUnit.type].canMove) {
        this.selectedUnitId = clickedUnit.id;
        sound.playSelect();
      } else {
        this.selectedUnitId = null;
      }
      this.notify();
    } else {
      this.selectedUnitId = null;
      this.notify();
    }
  }

  private handleSetupTileClick(q: number, r: number): void {
    if (!this.isDeploymentTile('player', q, r)) return;

    const existingUnit = this.getUnitAt(q, r);

    // If we have a unit selected on the board, swap or move it
    if (this.selectedUnitId) {
      const selectedUnit = this.units.find(u => u.id === this.selectedUnitId);
      if (selectedUnit && selectedUnit.faction === 'player') {
        if (selectedUnit.q === q && selectedUnit.r === r) {
          this.selectedUnitId = null;
          this.notify();
          return;
        }
        if (existingUnit && existingUnit.faction === 'player') {
          // Swap positions with smooth animation!
          const fromQ = selectedUnit.q;
          const fromR = selectedUnit.r;
          selectedUnit.q = existingUnit.q;
          selectedUnit.r = existingUnit.r;
          existingUnit.q = fromQ;
          existingUnit.r = fromR;
          this.selectedUnitId = null;
          this.activeMoveAnim = {
            unit: selectedUnit,
            fromQ,
            fromR,
            toQ: selectedUnit.q,
            toR: selectedUnit.r,
            startTime: performance.now(),
            duration: 240,
            swapUnit: existingUnit
          };
          sound.playMove();
          this.notify();
          return;
        } else if (!existingUnit) {
          const fromQ = selectedUnit.q;
          const fromR = selectedUnit.r;
          selectedUnit.q = q;
          selectedUnit.r = r;
          this.selectedUnitId = null;
          this.activeMoveAnim = {
            unit: selectedUnit,
            fromQ,
            fromR,
            toQ: q,
            toR: r,
            startTime: performance.now(),
            duration: 240
          };
          sound.playMove();
          this.notify();
          return;
        }
      }
    }

    // If clicking an existing player unit, select it to swap
    if (existingUnit && existingUnit.faction === 'player') {
      this.selectedUnitId = existingUnit.id;
      sound.playSelect();
      this.notify();
      return;
    }

    // If tile is empty and user has unplaced units, place selectedSetupType
    if (!existingUnit && this.selectedSetupType) {
      const counts = this.getUnplacedPlayerCounts();
      if (counts[this.selectedSetupType] > 0) {
        this.units.push({
          id: `player_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: this.selectedSetupType,
          faction: 'player',
          q,
          r,
          revealed: false,
          hasMovedEver: false
        });
        sound.playMove();
        // Auto-advance selectedSetupType if exhausted
        const updatedCounts = this.getUnplacedPlayerCounts();
        if (updatedCounts[this.selectedSetupType] <= 0) {
          const nextType = ORDERED_UNIT_TYPES.find(t => updatedCounts[t] > 0) || null;
          this.selectedSetupType = nextType;
        }
        this.notify();
      }
    }
  }

  public startBattle(): void {
    if (!this.isPlayerSetupComplete()) return;
    this.phase = 'player_turn';
    this.selectedUnitId = null;
    sound.playSelect();
    this.addLog('system', 'Die Schlacht beginnt! Du bist am Zug (Blau).');
    this.notify();
  }

  public getUnitAt(q: number, r: number): Unit | undefined {
    return this.units.find(u => u.q === q && u.r === r);
  }

  public getValidMoves(unit: Unit): AxialCoord[] {
    const def = UNIT_DEFINITIONS[unit.type];
    if (!def.canMove) return [];

    const moves: AxialCoord[] = [];

    // Scout can move up to maxMoveRange along any of the 6 hex directions in a straight line
    for (const dir of HEX_DIRECTIONS) {
      for (let step = 1; step <= def.maxMoveRange; step++) {
        const targetQ = unit.q + dir.q * step;
        const targetR = unit.r + dir.r * step;
        const tile = this.tiles.get(coordKey(targetQ, targetR));

        if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') {
          break; // Impassable terrain blocks line of movement
        }

        const occupant = this.getUnitAt(targetQ, targetR);
        if (!occupant) {
          moves.push({ q: targetQ, r: targetR });
        } else {
          if (occupant.faction !== unit.faction) {
            moves.push({ q: targetQ, r: targetR });
          }
          break; // Cannot jump over units
        }
      }
    }

    return moves;
  }

  public executeMove(
    unit: Unit,
    targetQ: number,
    targetR: number,
    animate = true,
    customStartOffset?: { fromX: number; fromY: number }
  ): void {
    const fromQ = unit.q;
    const fromR = unit.r;
    const defender = this.getUnitAt(targetQ, targetR);

    // Let AI observe player movement patterns before board state updates
    if (unit.faction === 'player') {
      this.aiEngine.observePlayerMove(unit, fromQ, fromR, targetQ, targetR, this.units);
    } else {
      this.aiEngine.recordAIMove(unit.id, fromQ, fromR, targetQ, targetR, this.turn);
    }

    this.selectedUnitId = null;
    unit.hasMovedEver = true;

    const dist = hexDistance({ q: fromQ, r: fromR }, { q: targetQ, r: targetR });

    // If Scout moves more than 1 hex, everyone knows it's a Scout!
    if (dist > 1) {
      unit.revealed = true;
    }

    this.lastMove = { fromQ, fromR, toQ: targetQ, toR: targetR };

    const finishMove = () => {
      this.activeMoveAnim = null;
      if (!defender) {
        unit.q = targetQ;
        unit.r = targetR;
        if (this.gameMode === 'scouts_only') {
          this.checkMoveExperience(unit, fromR, targetQ, targetR);
        }
        this.endTurn(unit.faction);
      } else {
        // Combat!
        this.resolveCombat(unit, defender);
      }
    };

    if (animate) {
      const duration = customStartOffset ? 150 : Math.min(480, 230 + dist * 65);
      this.phase = 'animating_move';
      this.activeMoveAnim = {
        unit,
        fromQ,
        fromR,
        toQ: targetQ,
        toR: targetR,
        startTime: performance.now(),
        duration,
        customStartOffset
      };
      sound.playMove();
      this.notify();
      setTimeout(finishMove, duration);
    } else {
      sound.playMove();
      finishMove();
    }
  }

  private resolveCombat(attacker: Unit, defender: Unit): void {
    const attDef = UNIT_DEFINITIONS[attacker.type];
    const defDef = UNIT_DEFINITIONS[defender.type];

    // Both units are revealed to the opponent in combat
    attacker.revealed = true;
    defender.revealed = true;

    let winner: 'attacker' | 'defender' | 'both_die';
    let reason = '';

    if (defender.type === 'flag') {
      winner = 'attacker';
      reason = `${attDef.name} erobert die feindliche Fahne!`;
    } else if (defender.type === 'bomb') {
      if (attacker.type === 'miner') {
        winner = 'attacker';
        reason = `${attDef.name} (3) entschärft die Bombe!`;
      } else {
        winner = 'defender';
        reason = `${attDef.name} (${attDef.rank}) läuft auf eine Bombe und wird vernichtet!`;
      }
    } else if (attacker.type === 'spy' && defender.type === 'marshal') {
      winner = 'attacker';
      reason = `Spion (Gefr, Rang 1) verübt ein erfolgreiches Attentat auf den General (4★, Rang 10)!`;
    } else if (attDef.rank > defDef.rank) {
      winner = 'attacker';
      reason = `${attDef.name} (${attDef.rank}) besiegt ${defDef.name} (${defDef.rank})!`;
    } else if (attDef.rank < defDef.rank) {
      winner = 'defender';
      reason = `${attDef.name} (${attDef.rank}) scheitert an ${defDef.name} (${defDef.rank})!`;
    } else {
      winner = 'both_die';
      reason = `Gleichstand! Beide ${attDef.name} (${attDef.rank}) vernichten sich gegenseitig.`;
    }

    if (defender.type === 'bomb' && winner === 'defender') {
      sound.playExplosion();
    } else {
      sound.playCombatSword();
    }

    const combatEvent: CombatEvent = {
      attacker: { ...attacker },
      defender: { ...defender },
      winner,
      fromQ: attacker.q,
      fromR: attacker.r,
      toQ: defender.q,
      toR: defender.r,
      reason,
      timestamp: Date.now()
    };

    this.activeCombat = combatEvent;
    this.addLog(attacker.faction, reason, true);

    // Award combat kill points & apply unit removals/movement
    const attKillVal = this.getUnitPointValue(attacker.type);
    const defKillVal = this.getUnitPointValue(defender.type);

    if (winner === 'attacker') {
      if (attacker.faction === 'player') {
        this.playerKills++;
        this.playerKillPoints += defKillVal;
      } else {
        this.aiKills++;
        this.aiKillPoints += defKillVal;
      }
      this.units = this.units.filter(u => u.id !== defender.id);
      attacker.q = defender.q;
      attacker.r = defender.r;
      if (this.gameMode === 'scouts_only' && defender.type !== 'flag') {
        const promoText = this.promoteUnit(attacker, 'Kampfsieg');
        if (promoText) {
          combatEvent.reason += ` ${promoText}`;
        }
      }
    } else if (winner === 'defender') {
      if (defender.faction === 'player') {
        this.playerKills++;
        this.playerKillPoints += attKillVal;
      } else {
        this.aiKills++;
        this.aiKillPoints += attKillVal;
      }
      this.units = this.units.filter(u => u.id !== attacker.id);
      if (this.gameMode === 'scouts_only' && defender.type !== 'bomb' && defender.type !== 'flag') {
        const promoText = this.promoteUnit(defender, 'Abwehrerfolg');
        if (promoText) {
          combatEvent.reason += ` ${promoText}`;
        }
      }
    } else {
      this.playerKills++;
      this.aiKills++;
      this.playerKillPoints += attacker.faction === 'player' ? defKillVal : attKillVal;
      this.aiKillPoints += attacker.faction === 'ai' ? defKillVal : attKillVal;
      this.units = this.units.filter(u => u.id !== attacker.id && u.id !== defender.id);
    }

    // Check if flag was captured
    if (defender.type === 'flag') {
      this.declareWinner(attacker.faction, reason);
      return;
    }

    this.phase = 'combat_anim';
    this.notify();

    setTimeout(() => {
      if (this.phase === 'game_over') return;
      this.activeCombat = null;
      this.endTurn(attacker.faction);
    }, 1800);
  }

  private checkMoveExperience(unit: Unit, fromR: number, toQ: number, toR: number): void {
    const idx = PROMOTION_CHAIN.indexOf(unit.type);
    if (idx === -1 || idx >= PROMOTION_CHAIN.length - 1) return;

    const tile = this.tiles.get(coordKey(toQ, toR));
    const isForward = unit.faction === 'player' ? toR < fromR : toR > fromR;
    const isForest = tile?.terrain === 'forest';

    if (isForward || isForest) {
      unit.xp = (unit.xp ?? 0) + 1;
      if (unit.xp >= 2) {
        const reason = isForest ? 'Wald-Aufklärung (2/2 EP)' : 'Front-Aufklärung (2/2 EP)';
        this.promoteUnit(unit, reason);
      }
    }
  }

  private promoteUnit(unit: Unit, triggerReason: string): string | null {
    const idx = PROMOTION_CHAIN.indexOf(unit.type);
    if (idx === -1 || idx >= PROMOTION_CHAIN.length - 1) return null;

    const oldDef = UNIT_DEFINITIONS[unit.type];
    const nextType = PROMOTION_CHAIN[idx + 1];
    const newDef = UNIT_DEFINITIONS[nextType];

    unit.type = nextType;
    unit.xp = 0;

    sound.playPromotion();
    const factionLabel = unit.faction === 'player' ? 'Dein' : 'Feindlicher';
    const msg = `⬆️ Beförderung (${triggerReason}): ${factionLabel} ${oldDef.name} steigt auf zu ${newDef.name} (Rang ${newDef.rank})!`;
    this.addLog(unit.faction, msg, false);
    return `⬆️ Befördert zu ${newDef.name} (Rang ${newDef.rank})!`;
  }

  private endTurn(justMovedFaction: Faction): void {
    const nextFaction: Faction = justMovedFaction === 'player' ? 'ai' : 'player';

    // Check if nextFaction has any valid moves left
    if (!this.hasAnyValidMoves(nextFaction)) {
      const winner = justMovedFaction;
      const loserName = nextFaction === 'player' ? 'Deine Armee' : 'Die KI-Armee';
      this.declareWinner(winner, `${loserName} hat keine beweglichen Einheiten mehr!`);
      return;
    }

    if (nextFaction === 'ai') {
      this.phase = 'ai_turn';
      this.notify();
      const expectedGameId = this.gameId;
      const expectedTurn = this.turn;
      setTimeout(() => {
        void this.performAITurn(expectedGameId, expectedTurn);
      }, 280);
    } else {
      this.turn++;
      this.phase = 'player_turn';
      this.notify();
    }
  }

  private hasAnyValidMoves(faction: Faction): boolean {
    for (const u of this.units) {
      if (u.faction === faction) {
        if (this.getValidMoves(u).length > 0) return true;
      }
    }
    return false;
  }

  private declareWinner(winner: Faction, reason: string): void {
    this.winner = winner;
    this.winReason = reason;
    this.phase = 'game_over';
    // Reveal all units at game over
    for (const u of this.units) {
      u.revealed = true;
    }
    if (winner === 'player') {
      this.matchWinsPlayer++;
      this.saveMatchScore();
      sound.playVictory();
      this.addLog('system', `🎉 SIEG! ${reason}`);
    } else {
      this.matchWinsAI++;
      this.saveMatchScore();
      sound.playDefeat();
      this.addLog('system', `💀 NIEDERLAGE! ${reason}`);
    }
    this.notify();
  }

  public getUnitPointValue(type: UnitType): number {
    switch (type) {
      case 'flag':
        return 2500;
      case 'marshal':
        return 1000;
      case 'general':
        return 800;
      case 'colonel':
        return 600;
      case 'major':
        return 450;
      case 'miner':
        return 400;
      case 'spy':
        return 380;
      case 'bomb':
        return 300;
      case 'captain':
        return 300;
      case 'lieutenant':
        return 220;
      case 'sergeant':
        return 160;
      case 'scout':
        return 140;
    }
  }

  public getScoreSummary(): GameScoreSummary {
    let playerArmyScore = 0;
    let aiArmyScore = 0;
    let playerUnitsAlive = 0;
    let aiUnitsAlive = 0;

    for (const u of this.units) {
      if (u.type === 'flag') {
        if (u.faction === 'player') playerUnitsAlive++;
        else aiUnitsAlive++;
        continue;
      }
      const basePts = this.getUnitPointValue(u.type);
      const xpBonus = (u.xp ?? 0) * 45;
      if (u.faction === 'player') {
        playerUnitsAlive++;
        const territoryBonus = u.r <= 1 ? (2 - u.r) * 15 : 0;
        playerArmyScore += basePts + xpBonus + territoryBonus;
      } else {
        aiUnitsAlive++;
        const territoryBonus = u.r >= -1 ? (u.r + 2) * 15 : 0;
        aiArmyScore += basePts + xpBonus + territoryBonus;
      }
    }

    const playerTotalScore = playerArmyScore + this.playerKillPoints;
    const aiTotalScore = aiArmyScore + this.aiKillPoints;

    const stats = this.aiEngine.lastSearchStats;
    let evalForPlayer = stats ? stats.evalForPlayer : 0;
    let playerWinProb = stats ? stats.playerWinProb : 50;

    if (!stats && this.units.length > 0) {
      const m = this.aiEngine.computeEvalMetrics(aiTotalScore - playerTotalScore);
      evalForPlayer = m.evalForPlayer;
      playerWinProb = m.playerWinProb;
    }

    if (this.phase === 'game_over') {
      evalForPlayer = this.winner === 'player' ? 99.9 : -99.9;
      playerWinProb = this.winner === 'player' ? 100 : 0;
    }

    return {
      playerTotalScore,
      aiTotalScore,
      playerArmyScore,
      aiArmyScore,
      playerKillPoints: this.playerKillPoints,
      aiKillPoints: this.aiKillPoints,
      playerKills: this.playerKills,
      aiKills: this.aiKills,
      playerUnitsAlive,
      aiUnitsAlive,
      evalForPlayer,
      playerWinProb,
      matchWinsPlayer: this.matchWinsPlayer,
      matchWinsAI: this.matchWinsAI
    };
  }

  // ============================================================================
  // AI ENGINE (Multi-Core Web Worker Pool: Non-Blocking Deep Search)
  // ============================================================================
  private async performAITurn(expectedGameId: number, expectedTurn: number): Promise<void> {
    if (this.phase !== 'ai_turn' || this.gameId !== expectedGameId || this.turn !== expectedTurn) {
      return;
    }

    const chosen = await this.aiPool.selectBestMoveAsync(
      this.units,
      this.tiles,
      this.turn,
      this.aiDifficulty,
      u => this.getValidMoves(u),
      this.gameMode
    );

    if (this.phase !== 'ai_turn' || this.gameId !== expectedGameId || this.turn !== expectedTurn) {
      return;
    }

    if (!chosen) {
      this.declareWinner('player', 'Die KI hat keine gültigen Züge mehr!');
      return;
    }

    this.executeMove(chosen.unit, chosen.toQ, chosen.toR);
  }

  public getLastAISearchStats(): AISearchStats | null {
    return this.aiEngine.lastSearchStats;
  }

  public addLog(faction: Faction | 'system', message: string, isCombat = false): void {
    this.logs.unshift({
      id: this.nextLogId++,
      turn: this.turn,
      faction,
      message,
      isCombat
    });
    if (this.logs.length > 50) {
      this.logs.pop();
    }
  }

  public getRemainingCounts(faction: Faction): Record<UnitType, number> {
    const counts = {} as Record<UnitType, number>;
    for (const t of ORDERED_UNIT_TYPES) {
      counts[t] = 0;
    }
    for (const u of this.units) {
      if (u.faction === faction) {
        counts[u.type]++;
      }
    }
    return counts;
  }

  private notify(): void {
    this.syncAI();
    this.onChangeCallback();
  }
}
