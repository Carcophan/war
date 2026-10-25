import { AxialCoord, coordKey, getNeighbors, HEX_DIRECTIONS, hexDistance } from './hex';
import {
  AIDifficulty,
  Faction,
  GameMode,
  getInitialUnitCount,
  HexTile,
  ORDERED_UNIT_TYPES,
  PROMOTION_CHAIN,
  Unit,
  UNIT_DEFINITIONS,
  UnitType
} from './types';

export interface UnitSuspicion {
  moveCount: number;
  minLikelyRank: number;
  maxLikelyRank: number;
  spySuspicion: number; // 0 to 1
  minerSuspicion: number; // 0 to 1
  bluffSuspicion: number; // 0 to 1
  approachedHighRank: boolean;
  retreatedFromRank: number | null;
  targetedUnmovedBackrow: boolean;
}

export interface AIMoveRecord {
  unitId: string;
  fromQ: number;
  fromR: number;
  toQ: number;
  toR: number;
  turn: number;
}

export interface UnitBelief {
  pFlag: number;
  pBomb: number;
  pByType: Record<UnitType, number>;
  entropy: number; // Shannon entropy in bits (0 = certain, ~3.5 = maximum uncertainty)
}

export interface AISearchStats {
  difficulty: AIDifficulty;
  isPondering: boolean;
  ponderPhase: 'setup_analysis' | 'pondering_player' | 'thinking_ai' | 'idle';
  depthReached: number;
  targetDepth: number;
  quiescenceDepth: number;
  nodesEvaluated: number;
  totalNodesAllTime: number;
  nodesPerSecond: number;
  ttHits: number;
  ttSize: number;
  worldsSampled: number;
  bestScore: number;
  evalForPlayer: number; // Positive = Player advantage, Negative = AI advantage (in 100-pt equivalents)
  playerWinProb: number; // 0..100%
  timeMs: number;
  predictedPlayerMove: string;
  plannedCounterMove: string;
  pvLine: string;
  tacticalSummary: string;
  workerCount?: number;
  activeWorkers?: number;
}

interface TTEntry {
  hash: number;
  depth: number;
  score: number;
  flag: 0 | 1 | 2; // 0 = EXACT, 1 = LOWERBOUND, 2 = UPPERBOUND
  bestUnitId: string;
  bestToQ: number;
  bestToR: number;
  age: number;
}

export interface PonderReplyEntry {
  aiUnitId: string;
  toQ: number;
  toR: number;
  score: number;
  depth: number;
  pvText: string;
}

export interface WorkerRootCandidate {
  unitId: string;
  toQ: number;
  toR: number;
  baseScore: number;
}

interface IncrementalPonderSession {
  boardSignature: string;
  sideToMove: Faction;
  phase: 'setup_analysis' | 'pondering_player' | 'thinking_ai';
  turn: number;
  difficulty: AIDifficulty;
  gameMode: GameMode;
  startTime: number;
  analysis: BoardAnalysis;
  worlds: Unit[][];
  worldWeights: number[];
  rootMoves: { unit: Unit; toQ: number; toR: number; baseScore: number }[];
  currentDepth: number; // Iterative deepening full-tree depth (starts at 2, goes up to 16+)
  quiescenceDepth: number; // Extra tactical plies (3)
  completedDepth: number;
  candIdx: number;
  worldIdx: number;
  candExpectedScore: number;
  candWorstScore: number;
  initialStaticScore: number;
  bestMoveAtCurrentDepth: { unit: Unit; toQ: number; toR: number; score: number } | null;
  bestScoreAtCurrentDepth: number;
  committedBestMove: { unit: Unit; toQ: number; toR: number; score: number } | null;
  committedBestScore: number;
  predictedPlayerMoveText: string;
  plannedCounterMoveText: string;
  pvLineText: string;
  sessionNodes: number;
}

export interface BoardAnalysis {
  hiddenPool: Record<UnitType, number>;
  totalHiddenMovable: number;
  unmovedHiddenUnits: Unit[];
  movedHiddenUnits: Unit[];
  unrevealedBombs: number;
  unrevealedFlag: number;
  playerMarshalAlive: boolean;
  playerMarshalRevealed: Unit | null;
  playerGeneralAlive: boolean;
  playerGeneralRevealed: Unit | null;
  playerSpyAlive: boolean;
  playerSpyRevealed: Unit | null;
  playerMinersAlive: number;
  aiMinersAlive: number;
  aiBombsAlive: number;
  aiSpyAlive: boolean;
  aiMarshalAlive: boolean;
  aiGeneralAlive: boolean;
  highestPlayerMovableRank: number;
  highestUnrevealedPlayerRank: number;
  highestAiMovableRank: number;
  aiFlag: Unit | null;
  aiLowMidProbersAlive: number;
  beliefMap: Map<string, UnitBelief>;
  mostLikelyFlagUnit: Unit | null;
}

// Strategic chokepoints and central bridges on the radius-4 hex map
const CENTRAL_CHOKEPOINTS: AxialCoord[] = [
  { q: -3, r: 0 },
  { q: -1, r: 0 },
  { q: 1, r: 0 },
  { q: 3, r: 0 },
  { q: -1, r: -1 },
  { q: 1, r: -1 },
  { q: -1, r: 1 },
  { q: 1, r: 1 }
];

export class FrontlineAIEngine {
  private suspicions: Map<string, UnitSuspicion> = new Map();
  private moveHistory: AIMoveRecord[] = [];
  public lastSearchStats: AISearchStats | null = null;
  private searchNodesCount = 0;
  private totalNodesAllTime = 0;
  private searchDeadline = 0;
  private ttMap: Map<number, TTEntry> = new Map();
  private ttHits = 0;
  private ttAge = 1;
  private killerMoves: Map<number, string> = new Map();
  private historyTable: Map<string, number> = new Map();
  private ponderResponseBook: Map<string, PonderReplyEntry> = new Map();
  private ponderSession: IncrementalPonderSession | null = null;
  private lastKnownPlayerMoveKey: string | null = null;
  private workerSessionSeed: number | null = null;
  private workerCachedAnalysis: BoardAnalysis | null = null;
  private workerCachedWorlds: Unit[][] = [];
  private workerCachedTiles: Map<string, HexTile> = new Map();
  private workerCachedSideToMove: Faction = 'player';
  private workerCachedGameMode: GameMode = 'classic';

  public reset(): void {
    this.suspicions.clear();
    this.moveHistory = [];
    this.lastSearchStats = null;
    this.ttMap.clear();
    this.ttHits = 0;
    this.ttAge = 1;
    this.killerMoves.clear();
    this.historyTable.clear();
    this.ponderResponseBook.clear();
    this.ponderSession = null;
    this.lastKnownPlayerMoveKey = null;
    this.totalNodesAllTime = 0;
    this.workerSessionSeed = null;
    this.workerCachedAnalysis = null;
    this.workerCachedWorlds = [];
  }

  public getLastKnownPlayerMoveKey(): string | null {
    return this.lastKnownPlayerMoveKey;
  }

  public exportEngineState(): {
    suspicions: [string, UnitSuspicion][];
    moveHistory: AIMoveRecord[];
    lastKnownPlayerMoveKey: string | null;
    ttAge: number;
  } {
    return {
      suspicions: Array.from(this.suspicions.entries()).map(([k, v]) => [k, { ...v }]),
      moveHistory: this.moveHistory.map(m => ({ ...m })),
      lastKnownPlayerMoveKey: this.lastKnownPlayerMoveKey,
      ttAge: this.ttAge
    };
  }

  public importEngineState(state: {
    suspicions: [string, UnitSuspicion][];
    moveHistory: AIMoveRecord[];
    lastKnownPlayerMoveKey: string | null;
    ttAge: number;
  }): void {
    this.suspicions = new Map(state.suspicions);
    this.moveHistory = state.moveHistory;
    this.lastKnownPlayerMoveKey = state.lastKnownPlayerMoveKey;
    this.ttAge = state.ttAge;
  }

  public getValidMovesForUnit(unit: Unit, units: Unit[], tiles: Map<string, HexTile>): AxialCoord[] {
    const def = UNIT_DEFINITIONS[unit.type];
    if (!def.canMove) return [];

    const moves: AxialCoord[] = [];
    for (const dir of HEX_DIRECTIONS) {
      for (let step = 1; step <= def.maxMoveRange; step++) {
        const targetQ = unit.q + dir.q * step;
        const targetR = unit.r + dir.r * step;
        const tile = tiles.get(coordKey(targetQ, targetR));
        if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') {
          break;
        }
        const occupant = units.find(u => u.q === targetQ && u.r === targetR);
        if (!occupant) {
          moves.push({ q: targetQ, r: targetR });
        } else {
          if (occupant.faction !== unit.faction) {
            moves.push({ q: targetQ, r: targetR });
          }
          break;
        }
      }
    }
    return moves;
  }

  /**
   * Initializes a determinized search session inside a Web Worker thread.
   */
  public initWorkerSession(
    units: Unit[],
    tiles: Map<string, HexTile>,
    sideToMove: Faction,
    turn: number,
    difficulty: AIDifficulty,
    gameMode: GameMode,
    sessionSeed: number,
    precomputedReply?: PonderReplyEntry
  ): {
    rootMoves: WorkerRootCandidate[];
    worldWeights: number[];
    worldsCount: number;
    initialStaticScore: number;
  } {
    this.workerSessionSeed = sessionSeed;
    this.workerCachedTiles = tiles;
    this.workerCachedSideToMove = sideToMove;
    this.workerCachedGameMode = gameMode;

    if (this.ttMap.size > 90000) {
      for (const [k, v] of this.ttMap) {
        if (v.age < this.ttAge - 1 && v.depth <= 3) {
          this.ttMap.delete(k);
        }
      }
      if (this.ttMap.size > 85000) {
        this.ttMap.clear();
      }
    }

    const analysis = this.analyzeBoard(units);
    const worlds = this.buildDeterminizedWorlds(units, analysis);
    const worldWeights = worlds.length === 4 ? [0.45, 0.25, 0.15, 0.15] : [1.0];

    this.workerCachedAnalysis = analysis;
    this.workerCachedWorlds = worlds;

    let rootMoves: WorkerRootCandidate[] = [];

    if (sideToMove === 'ai') {
      const aiMovable = units.filter(u => u.faction === 'ai' && UNIT_DEFINITIONS[u.type].canMove);
      const currentUnitDanger = new Map<string, number>();
      const unitStartDistMap = new Map<string, Map<string, number>>();
      for (const au of aiMovable) {
        currentUnitDanger.set(
          au.id,
          this.evaluateCounterAttackRisk(au, au.q, au.r, au.revealed, tiles, units, analysis)
        );
        unitStartDistMap.set(au.id, this.computeDistanceMapFrom(au.q, au.r, au, tiles, units));
      }

      for (const u of aiMovable) {
        const vMoves = this.getValidMovesForUnit(u, units, tiles);
        const sDists = unitStartDistMap.get(u.id)!;
        for (const m of vMoves) {
          let sc = this.evaluateMove(
            u,
            m.q,
            m.r,
            units,
            tiles,
            turn,
            difficulty,
            analysis,
            currentUnitDanger,
            sDists,
            gameMode
          );
          if (
            precomputedReply &&
            precomputedReply.aiUnitId === u.id &&
            precomputedReply.toQ === m.q &&
            precomputedReply.toR === m.r
          ) {
            sc += 120;
          }
          rootMoves.push({ unitId: u.id, toQ: m.q, toR: m.r, baseScore: sc });
        }
      }
      rootMoves.sort((a, b) => b.baseScore - a.baseScore);
      const viableMoves = rootMoves.filter(m => m.baseScore > -8000);
      rootMoves = (viableMoves.length > 0 ? viableMoves : rootMoves).slice(0, 18);
    } else {
      const orderedPlayerMoves = this.generateOrderedWorldMoves(
        worlds[0],
        'player',
        tiles,
        false,
        16,
        undefined,
        1,
        analysis
      );
      for (const pm of orderedPlayerMoves) {
        rootMoves.push({
          unitId: pm.unitId,
          toQ: pm.toQ,
          toR: pm.toR,
          baseScore: pm.orderScore
        });
      }
    }

    const initialStaticScore =
      worlds.length > 0 ? this.evaluateWorldState(worlds[0], sideToMove, analysis) : 0;

    return {
      rootMoves,
      worldWeights,
      worldsCount: worlds.length,
      initialStaticScore
    };
  }

  /**
   * Evaluates a single (candidateMove, worldIdx) subtree at the requested depth inside a Web Worker.
   */
  public evaluateWorkerTask(
    candMove: WorkerRootCandidate,
    worldIdx: number,
    depth: number,
    quiescenceDepth: number,
    budgetMs: number
  ): {
    wScore: number;
    nodes: number;
    ttHits: number;
    ttSize: number;
    replyEntry?: PonderReplyEntry;
    aiPvLine?: string;
  } {
    const analysis = this.workerCachedAnalysis;
    const worldUnits = this.workerCachedWorlds[worldIdx];
    const tiles = this.workerCachedTiles;
    const sideToMove = this.workerCachedSideToMove;
    const gameMode = this.workerCachedGameMode;

    if (!analysis || !worldUnits) {
      return { wScore: 0, nodes: 0, ttHits: this.ttHits, ttSize: this.ttMap.size };
    }

    this.searchNodesCount = 0;
    this.searchDeadline = performance.now() + Math.max(budgetMs, 24);

    const simResult = this.applyMoveInWorld(
      worldUnits,
      candMove.unitId,
      candMove.toQ,
      candMove.toR,
      tiles,
      gameMode
    );

    let wScore: number;
    if (simResult.terminalWinner === 'ai') {
      wScore = 45000 + depth * 300;
    } else if (simResult.terminalWinner === 'player') {
      wScore = -45000 - depth * 300;
    } else {
      const nextSide: Faction = sideToMove === 'ai' ? 'player' : 'ai';
      wScore = this.alphaBetaSearch(
        simResult.nextUnits,
        depth,
        quiescenceDepth,
        -50000,
        50000,
        nextSide,
        tiles,
        analysis,
        gameMode,
        worldIdx,
        1
      );
    }

    this.totalNodesAllTime += this.searchNodesCount;

    let replyEntry: PonderReplyEntry | undefined;
    let aiPvLine: string | undefined;

    if (sideToMove === 'player' && worldIdx === 0 && !simResult.terminalWinner) {
      const childHash = this.computeWorldHash(simResult.nextUnits, 'ai', 0);
      const replyTT = this.ttMap.get(childHash);
      if (replyTT && replyTT.bestUnitId) {
        const pvStr = this.extractPVLine(simResult.nextUnits, 'ai', 0, tiles, gameMode, 4);
        replyEntry = {
          aiUnitId: replyTT.bestUnitId,
          toQ: replyTT.bestToQ,
          toR: replyTT.bestToR,
          score: wScore,
          depth: depth + 1 + quiescenceDepth,
          pvText: pvStr
        };
      }
    } else if (sideToMove === 'ai' && worldIdx === 0) {
      aiPvLine = simResult.terminalWinner
        ? '🏆 Sieg'
        : this.extractPVLine(simResult.nextUnits, 'player', 0, tiles, gameMode, 4);
    }

    return {
      wScore,
      nodes: this.searchNodesCount,
      ttHits: this.ttHits,
      ttSize: this.ttMap.size,
      replyEntry,
      aiPvLine
    };
  }

  /**
   * Called whenever a player unit moves or attacks, BEFORE the move is applied,
   * so the AI can deduce behavioral & psychological clues from human movement patterns.
   */
  public observePlayerMove(
    unit: Unit,
    fromQ: number,
    fromR: number,
    toQ: number,
    toR: number,
    allUnits: Unit[]
  ): void {
    this.lastKnownPlayerMoveKey = `${unit.id}:${toQ},${toR}`;
    this.ttAge++;
    let susp = this.suspicions.get(unit.id);
    if (!susp) {
      susp = {
        moveCount: 0,
        minLikelyRank: 1,
        maxLikelyRank: 10,
        spySuspicion: 0,
        minerSuspicion: 0,
        bluffSuspicion: 0,
        approachedHighRank: false,
        retreatedFromRank: null,
        targetedUnmovedBackrow: false
      };
      this.suspicions.set(unit.id, susp);
    }
    susp.moveCount++;

    const moveDist = hexDistance({ q: fromQ, r: fromR }, { q: toQ, r: toR });
    if (moveDist > 1) {
      susp.minLikelyRank = 2;
      susp.maxLikelyRank = 2;
    }

    const targetOccupant = allUnits.find(u => u.q === toQ && u.r === toR);

    // If attacking an unmoved AI unit in the deep backrow or a revealed AI Bomb, strong Miner / Probe suspicion
    if (targetOccupant && targetOccupant.faction === 'ai') {
      if ((targetOccupant.revealed && targetOccupant.type === 'bomb') || (!targetOccupant.hasMovedEver && targetOccupant.r <= -3)) {
        susp.minerSuspicion = Math.min(1, susp.minerSuspicion + 0.65);
      }
      if (targetOccupant.revealed && targetOccupant.type === 'marshal') {
        susp.spySuspicion = Math.min(1, susp.spySuspicion + 0.85);
      }
    }

    // If player is moving onto an empty square, analyze what was adjacent before and after
    if (!targetOccupant) {
      const oldNeighbors = getNeighbors(fromQ, fromR);
      const newNeighbors = getNeighbors(toQ, toR);

      // 1. Did the player retreat away from a revealed AI unit?
      for (const on of oldNeighbors) {
        const aiNeighbor = allUnits.find(u => u.faction === 'ai' && u.q === on.q && u.r === on.r);
        if (aiNeighbor && aiNeighbor.revealed) {
          const stillAdjacent = newNeighbors.some(nn => nn.q === aiNeighbor.q && nn.r === aiNeighbor.r);
          const distAfter = hexDistance({ q: toQ, r: toR }, { q: aiNeighbor.q, r: aiNeighbor.r });
          if (!stillAdjacent && distAfter > 1) {
            const aiRank = UNIT_DEFINITIONS[aiNeighbor.type].rank;
            if (aiRank >= 2 && aiRank <= 10) {
              // Player fled from a revealed AI unit of rank aiRank -> likely weaker than aiRank!
              susp.maxLikelyRank = Math.min(susp.maxLikelyRank, aiRank - 1);
              susp.retreatedFromRank = aiRank;
            }
          }
        }
      }

      // 2. Did the player deliberately step adjacent to an AI unit?
      for (const nn of newNeighbors) {
        const aiNeighbor = allUnits.find(u => u.faction === 'ai' && u.q === nn.q && u.r === nn.r);
        if (!aiNeighbor) continue;

        if (aiNeighbor.revealed) {
          const aiRank = UNIT_DEFINITIONS[aiNeighbor.type].rank;
          if (aiNeighbor.type === 'marshal') {
            // Stepping next to a revealed Marshal without attacking immediately: strong Spy or Marshal suspicion!
            susp.spySuspicion = Math.min(1, susp.spySuspicion + 0.72);
          } else if (aiNeighbor.type === 'bomb') {
            // Stepping right next to a revealed Bomb -> very likely a Miner (Rank 3)!
            susp.minerSuspicion = Math.min(1, susp.minerSuspicion + 0.78);
          } else if (aiRank >= 4 && aiRank <= 9) {
            // Player stepped right up to our revealed officer -> almost certainly beats it (rank + 1) or equals it!
            susp.minLikelyRank = Math.max(susp.minLikelyRank, Math.min(10, aiRank + 1));
            susp.approachedHighRank = true;
            if (aiRank >= 8 && !unit.revealed) {
              susp.spySuspicion = Math.min(1, susp.spySuspicion + 0.32);
            }
          }
        } else if (!aiNeighbor.hasMovedEver && aiNeighbor.r <= -3) {
          // Player marched up to an unmoved AI backrow piece (potential Bomb/Flag) -> likely Miner or Prober!
          susp.targetedUnmovedBackrow = true;
          susp.minerSuspicion = Math.min(1, susp.minerSuspicion + 0.50);
        }
      }

      // 3. Check if the player is actively approaching any revealed high-rank AI officer (Marshal/General/Colonel) from distance 2-3
      for (const au of allUnits) {
        if (au.faction !== 'ai' || !au.revealed) continue;
        const aiRank = UNIT_DEFINITIONS[au.type].rank;
        if (aiRank < 7 || aiRank > 10) continue;
        const dBefore = hexDistance({ q: fromQ, r: fromR }, { q: au.q, r: au.r });
        const dAfter = hexDistance({ q: toQ, r: toR }, { q: au.q, r: au.r });
        if (dAfter < dBefore && dAfter <= 2) {
          if (au.type === 'marshal') {
            susp.spySuspicion = Math.min(1, susp.spySuspicion + 0.35);
            susp.approachedHighRank = true;
          } else {
            susp.minLikelyRank = Math.max(susp.minLikelyRank, aiRank);
            susp.approachedHighRank = true;
          }
        }
      }

      // 4. Check if the player is shadowing an own revealed high-rank officer (classic Spy-escorting-General/Colonel bait!)
      for (const pu of allUnits) {
        if (pu.faction !== 'player' || pu.id === unit.id || !pu.revealed) continue;
        const puRank = UNIT_DEFINITIONS[pu.type].rank;
        if (puRank >= 7 && puRank <= 9) {
          const dAfter = hexDistance({ q: toQ, r: toR }, { q: pu.q, r: pu.r });
          if (dAfter === 1) {
            susp.spySuspicion = Math.min(1, susp.spySuspicion + 0.42);
          }
        }
      }
    }
  }

  public recordAIMove(unitId: string, fromQ: number, fromR: number, toQ: number, toR: number, turn: number): void {
    this.moveHistory.unshift({ unitId, fromQ, fromR, toQ, toR, turn });
    if (this.moveHistory.length > 28) {
      this.moveHistory.pop();
    }
  }

  /**
   * Smart Grandmaster Deployment for AI (and Player Auto-Deploy).
   * Uses Mixed-Strategy Nash Deception (randomized corner citadels, offset bastions & decoy bomb traps)
   * while guaranteeing 100% of movable hexes can reach the frontline.
   */
  public deploySmartArmy(
    faction: Faction,
    availableCoords: AxialCoord[],
    tiles: Map<string, HexTile>,
    gameMode: GameMode = 'classic'
  ): { type: UnitType; q: number; r: number }[] {
    const backRowR = faction === 'player' ? 4 : -4;
    const midRowR = faction === 'player' ? 3 : -3;
    const frontRowR = faction === 'player' ? 2 : -2;
    const enemyFrontR = faction === 'player' ? 1 : -1;

    const coordSet = new Set(availableCoords.map(c => coordKey(c.q, c.r)));

    // Try up to 30 times to generate a formation where 100% of movable hexes can reach the frontline
    for (let attempt = 0; attempt < 30; attempt++) {
      const usedKeys = new Set<string>();
      const placed: { type: UnitType; q: number; r: number }[] = [];

      const take = (q: number, r: number, type: UnitType) => {
        usedKeys.add(coordKey(q, r));
        placed.push({ type, q, r });
      };

      const backRow = availableCoords.filter(c => c.r === backRowR);
      backRow.sort((a, b) => a.q - b.q);

      // Game-Theoretic Mixed Strategy for Flag Placement:
      // 70% Corner Kingpin Citadel (left or right corner), 30% Deceptive Inner-Pocket Bastion (index 1 or length-2)
      // so an opponent cannot deterministically guess the Flag tile!
      const roll = Math.random();
      let flagCoord: AxialCoord;
      let decoyCornerCoord: AxialCoord | null = null;

      if (roll < 0.35) {
        flagCoord = backRow[0];
        decoyCornerCoord = backRow[backRow.length - 1];
      } else if (roll < 0.70) {
        flagCoord = backRow[backRow.length - 1];
        decoyCornerCoord = backRow[0];
      } else if (roll < 0.85 && backRow.length >= 4) {
        flagCoord = backRow[1];
        decoyCornerCoord = backRow[backRow.length - 1];
      } else if (backRow.length >= 4) {
        flagCoord = backRow[backRow.length - 2];
        decoyCornerCoord = backRow[0];
      } else {
        flagCoord = backRow[0];
      }

      take(flagCoord.q, flagCoord.r, 'flag');

      // Identify neighbors of the Flag
      const flagNeighbors = getNeighbors(flagCoord.q, flagCoord.r).filter(
        n => coordSet.has(coordKey(n.q, n.r)) && !usedKeys.has(coordKey(n.q, n.r))
      );

      // Find the Kingpin neighbor in midRowR that touches the most other flagNeighbors
      const kingpinCoord = flagNeighbors.find(
        cand =>
          cand.r === midRowR &&
          flagNeighbors.every(other => other === cand || hexDistance(cand, other) === 1)
      );

      let bombsPlaced = 0;
      if (kingpinCoord && flagNeighbors.length === 3) {
        // Place 2 Bombs on the two flank neighbors of the Flag
        for (const fn of flagNeighbors) {
          if (fn.q === kingpinCoord.q && fn.r === kingpinCoord.r) continue;
          take(fn.q, fn.r, 'bomb');
          bombsPlaced++;
        }
        // Place the Goalie (Major 7 in classic, Scout in scouts_only) on the Kingpin Hex right in front of the Flag!
        take(kingpinCoord.q, kingpinCoord.r, gameMode === 'scouts_only' ? 'scout' : 'major');

        // 3rd Bomb: either shield the Kingpin Hex in frontRowR OR create a Decoy Bomb Trap on the opposite flank!
        const useDecoyBomb = decoyCornerCoord && Math.random() < 0.35;
        if (!useDecoyBomb) {
          const shieldCandidates = getNeighbors(kingpinCoord.q, kingpinCoord.r).filter(
            n =>
              n.r === frontRowR &&
              coordSet.has(coordKey(n.q, n.r)) &&
              !usedKeys.has(coordKey(n.q, n.r))
          );
          if (shieldCandidates.length > 0) {
            const shield = shieldCandidates[Math.floor(Math.random() * shieldCandidates.length)];
            take(shield.q, shield.r, 'bomb');
            bombsPlaced++;
          }
        }
      } else {
        // Inner-pocket Bastion: seal 2 neighbors of the Flag with Bombs and 1 with Major/Colonel
        shuffle(flagNeighbors);
        for (const fn of flagNeighbors) {
          if (bombsPlaced < 2) {
            take(fn.q, fn.r, 'bomb');
            bombsPlaced++;
          } else if (!usedKeys.has(coordKey(fn.q, fn.r))) {
            take(fn.q, fn.r, gameMode === 'scouts_only' ? 'scout' : 'major');
          }
        }
      }

      // Fallback / 3rd Tactical Choke Bomb placement
      if (bombsPlaced < 3) {
        const candidates = availableCoords.filter(
          c => !usedKeys.has(coordKey(c.q, c.r)) && (c.r === midRowR || c.r === frontRowR)
        );
        shuffle(candidates);
        if (candidates.length > 0) {
          take(candidates[0].q, candidates[0].r, 'bomb');
          bombsPlaced++;
        }
      }

      // Verify that NO remaining available deployment tile is cut off from the frontline!
      const remainingTiles = availableCoords.filter(c => !usedKeys.has(coordKey(c.q, c.r)));
      if (!this.areAllTilesReachableFromFrontline(remainingTiles, usedKeys, tiles, enemyFrontR)) {
        continue; // Retry another bomb configuration so no movable unit is ever trapped
      }

      if (gameMode === 'scouts_only') {
        for (const c of remainingTiles) {
          if (!usedKeys.has(coordKey(c.q, c.r))) {
            take(c.q, c.r, 'scout');
          }
        }
        if (placed.length === availableCoords.length) {
          return placed;
        }
        continue;
      }

      // Assign movable units to strategic roles!
      const frontTiles = remainingTiles.filter(c => c.r === frontRowR);
      const midTiles = remainingTiles.filter(c => c.r === midRowR);
      const backTiles = remainingTiles.filter(c => c.r === backRowR);

      // Score front tiles by how open their forward lines are (great for Scouts and fast pushers)
      const scoreFrontOpenness = (c: AxialCoord): number => {
        let openSteps = 0;
        for (const dir of HEX_DIRECTIONS) {
          for (let s = 1; s <= 3; s++) {
            const tq = c.q + dir.q * s;
            const tr = c.r + dir.r * s;
            const tile = tiles.get(coordKey(tq, tr));
            if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') break;
            if ((faction === 'ai' && tr > c.r) || (faction === 'player' && tr < c.r)) {
              openSteps++;
            }
          }
        }
        return openSteps + (Math.random() - 0.5) * 0.6;
      };

      frontTiles.sort((a, b) => scoreFrontOpenness(b) - scoreFrontOpenness(a));

      // Place 2 Scouts on the best open front-row hexes
      let scoutsToPlace = 2;
      for (const ft of [...frontTiles]) {
        if (scoutsToPlace <= 0) break;
        if (!usedKeys.has(coordKey(ft.q, ft.r))) {
          take(ft.q, ft.r, 'scout');
          scoutsToPlace--;
        }
      }

      // Ensure any remaining unsealed neighbor of the Flag has a strong defender
      let majorAlreadyPlaced = placed.some(p => p.type === 'major');
      for (const fn of flagNeighbors) {
        if (!usedKeys.has(coordKey(fn.q, fn.r))) {
          if (!majorAlreadyPlaced) {
            take(fn.q, fn.r, 'major');
            majorAlreadyPlaced = true;
          } else {
            take(fn.q, fn.r, 'captain');
          }
        }
      }

      // Place General (9) and Marshal (10) on opposite flanks, with Spy (1) shadowing General (9)
      const unusedMidAndFront = remainingTiles.filter(
        c => !usedKeys.has(coordKey(c.q, c.r)) && (c.r === midRowR || c.r === frontRowR)
      );
      unusedMidAndFront.sort((a, b) => a.q - b.q);

      if (unusedMidAndFront.length >= 2) {
        const leftWing = unusedMidAndFront.slice(0, Math.ceil(unusedMidAndFront.length / 2));
        const rightWing = unusedMidAndFront.slice(Math.ceil(unusedMidAndFront.length / 2));
        shuffle(leftWing);
        shuffle(rightWing);

        const swapWings = Math.random() < 0.5;
        const generalWing = swapWings ? leftWing : rightWing;
        const marshalWing = swapWings ? rightWing : leftWing;

        const genCoord = generalWing.find(c => c.r === midRowR) || generalWing[0];
        take(genCoord.q, genCoord.r, 'general');

        // Place Spy adjacent to General (preferring midRow or backRow)
        const spyCandidates = remainingTiles.filter(
          c => !usedKeys.has(coordKey(c.q, c.r)) && hexDistance(c, genCoord) === 1
        );
        spyCandidates.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        let spyPlaced = false;
        if (spyCandidates.length > 0) {
          take(spyCandidates[0].q, spyCandidates[0].r, 'spy');
          spyPlaced = true;
        }

        const marCandidates = marshalWing.filter(c => !usedKeys.has(coordKey(c.q, c.r)));
        if (marCandidates.length > 0) {
          take(marCandidates[0].q, marCandidates[0].r, 'marshal');
        }

        if (!spyPlaced) {
          const fallbackSpy = remainingTiles.find(
            c => !usedKeys.has(coordKey(c.q, c.r)) && (c.r === midRowR || c.r === backRowR)
          );
          if (fallbackSpy) take(fallbackSpy.q, fallbackSpy.r, 'spy');
        }
      }

      // Place 2 Miners in backRow / midRow (safe reserve for endgame bomb clearing!)
      const safeMinerSlots = [...backTiles, ...midTiles].filter(c => !usedKeys.has(coordKey(c.q, c.r)));
      shuffle(safeMinerSlots);
      let minersPlaced = 0;
      for (const slot of safeMinerSlots) {
        if (minersPlaced >= 2) break;
        take(slot.q, slot.r, 'miner');
        minersPlaced++;
      }

      // Fill out the rest of the pool into remaining slots, prioritizing officers to the front/mid rows
      const placedCounts: Record<UnitType, number> = {
        marshal: 0,
        general: 0,
        colonel: 0,
        major: 0,
        captain: 0,
        lieutenant: 0,
        sergeant: 0,
        miner: 0,
        scout: 0,
        spy: 0,
        bomb: 0,
        flag: 0
      };
      for (const p of placed) {
        placedCounts[p.type]++;
      }

      const leftoverPool: UnitType[] = [];
      for (const t of ORDERED_UNIT_TYPES) {
        const rem = UNIT_DEFINITIONS[t].count - placedCounts[t];
        for (let i = 0; i < rem; i++) {
          leftoverPool.push(t);
        }
      }

      leftoverPool.sort((a, b) => {
        const scoreType = (t: UnitType) => {
          if (t === 'scout') return 100;
          if (t === 'sergeant' || t === 'lieutenant' || t === 'captain') return 90;
          if (t === 'major' || t === 'colonel') return 82;
          if (t === 'miner') return 30;
          return 50;
        };
        return scoreType(b) - scoreType(a) + (Math.random() - 0.5) * 15;
      });

      const finalCoords = remainingTiles.filter(c => !usedKeys.has(coordKey(c.q, c.r)));
      finalCoords.sort((a, b) => Math.abs(a.r - frontRowR) - Math.abs(b.r - frontRowR));

      for (let i = 0; i < finalCoords.length && i < leftoverPool.length; i++) {
        take(finalCoords[i].q, finalCoords[i].r, leftoverPool[i]);
      }

      if (placed.length === availableCoords.length) {
        return placed;
      }
    }

    // Fallback
    const fallback: { type: UnitType; q: number; r: number }[] = [];
    const pool: UnitType[] = [];
    for (const t of ORDERED_UNIT_TYPES) {
      const count = getInitialUnitCount(t, gameMode);
      for (let i = 0; i < count; i++) pool.push(t);
    }
    for (let i = 0; i < availableCoords.length; i++) {
      fallback.push({ type: pool[i], q: availableCoords[i].q, r: availableCoords[i].r });
    }
    return fallback;
  }

  private areAllTilesReachableFromFrontline(
    movableTiles: AxialCoord[],
    blockedKeys: Set<string>,
    tiles: Map<string, HexTile>,
    enemyFrontR: number
  ): boolean {
    const movableSet = new Set(movableTiles.map(c => coordKey(c.q, c.r)));
    const visited = new Set<string>();
    const queue: AxialCoord[] = [];

    for (const c of movableTiles) {
      const neighbors = getNeighbors(c.q, c.r);
      const touchesNeutral = neighbors.some(n => {
        const nt = tiles.get(coordKey(n.q, n.r));
        return nt && nt.r === enemyFrontR && nt.terrain !== 'water' && nt.terrain !== 'mountain';
      });
      if (touchesNeutral) {
        visited.add(coordKey(c.q, c.r));
        queue.push(c);
      }
    }

    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const n of getNeighbors(curr.q, curr.r)) {
        const key = coordKey(n.q, n.r);
        if (visited.has(key) || blockedKeys.has(key) || !movableSet.has(key)) continue;
        visited.add(key);
        queue.push(n);
      }
    }

    return visited.size === movableTiles.length;
  }

  /**
   * Builds a complete board analysis, card-counting summary, and jointly calibrated
   * Sinkhorn-Knopp Bayesian Belief Matrix for all player units.
   */
  public analyzeBoard(units: Unit[]): BoardAnalysis {
    const hiddenPool: Record<UnitType, number> = {
      marshal: 0,
      general: 0,
      colonel: 0,
      major: 0,
      captain: 0,
      lieutenant: 0,
      sergeant: 0,
      miner: 0,
      scout: 0,
      spy: 0,
      bomb: 0,
      flag: 0
    };

    const unmovedHiddenUnits: Unit[] = [];
    const movedHiddenUnits: Unit[] = [];

    let playerMarshalAlive = false;
    let playerMarshalRevealed: Unit | null = null;
    let playerGeneralAlive = false;
    let playerGeneralRevealed: Unit | null = null;
    let playerSpyAlive = false;
    let playerSpyRevealed: Unit | null = null;
    let playerMinersAlive = 0;

    let aiMinersAlive = 0;
    let aiBombsAlive = 0;
    let aiSpyAlive = false;
    let aiMarshalAlive = false;
    let aiGeneralAlive = false;
    let aiFlag: Unit | null = null;
    let aiLowMidProbersAlive = 0;

    let highestPlayerMovableRank = 0;
    let highestUnrevealedPlayerRank = 0;
    let highestAiMovableRank = 0;

    for (const u of units) {
      if (u.faction === 'player') {
        const def = UNIT_DEFINITIONS[u.type];
        if (def.canMove && def.rank > highestPlayerMovableRank) {
          highestPlayerMovableRank = def.rank;
        }
        if (u.type === 'marshal') {
          playerMarshalAlive = true;
          if (u.revealed) playerMarshalRevealed = u;
        }
        if (u.type === 'general') {
          playerGeneralAlive = true;
          if (u.revealed) playerGeneralRevealed = u;
        }
        if (u.type === 'spy') {
          playerSpyAlive = true;
          if (u.revealed) playerSpyRevealed = u;
        }
        if (u.type === 'miner') {
          playerMinersAlive++;
        }

        if (!u.revealed) {
          hiddenPool[u.type]++;
          if (def.canMove && def.rank > highestUnrevealedPlayerRank) {
            highestUnrevealedPlayerRank = def.rank;
          }
          if (u.hasMovedEver) {
            movedHiddenUnits.push(u);
          } else {
            unmovedHiddenUnits.push(u);
          }
        }
      } else {
        const def = UNIT_DEFINITIONS[u.type];
        if (def.canMove && def.rank > highestAiMovableRank) {
          highestAiMovableRank = def.rank;
        }
        if (u.type === 'miner') aiMinersAlive++;
        if (u.type === 'bomb') aiBombsAlive++;
        if (u.type === 'spy') aiSpyAlive = true;
        if (u.type === 'marshal') aiMarshalAlive = true;
        if (u.type === 'general') aiGeneralAlive = true;
        if (u.type === 'flag') aiFlag = u;
        if (
          u.type === 'scout' ||
          u.type === 'sergeant' ||
          u.type === 'lieutenant' ||
          u.type === 'captain'
        ) {
          aiLowMidProbersAlive++;
        }
      }
    }

    let totalHiddenMovable = 0;
    for (const t of ORDERED_UNIT_TYPES) {
      if (t !== 'bomb' && t !== 'flag') {
        totalHiddenMovable += hiddenPool[t];
      }
    }

    const partialAnalysis: BoardAnalysis = {
      hiddenPool,
      totalHiddenMovable,
      unmovedHiddenUnits,
      movedHiddenUnits,
      unrevealedBombs: hiddenPool.bomb,
      unrevealedFlag: hiddenPool.flag,
      playerMarshalAlive,
      playerMarshalRevealed,
      playerGeneralAlive,
      playerGeneralRevealed,
      playerSpyAlive,
      playerSpyRevealed,
      playerMinersAlive,
      aiMinersAlive,
      aiBombsAlive,
      aiSpyAlive,
      aiMarshalAlive,
      aiGeneralAlive,
      highestPlayerMovableRank,
      highestUnrevealedPlayerRank,
      highestAiMovableRank,
      aiFlag,
      aiLowMidProbersAlive,
      beliefMap: new Map(),
      mostLikelyFlagUnit: null
    };

    // Compute Jointly Calibrated Bayesian Beliefs via Sinkhorn-Knopp (Iterative Proportional Fitting)
    this.populateJointBeliefs(partialAnalysis, units);

    return partialAnalysis;
  }

  /**
   * Computes raw likelihood weights for an unrevealed unit and then applies Sinkhorn-Knopp
   * matrix balancing across all player units so marginal probabilities match exact card counts!
   */
  private populateJointBeliefs(analysis: BoardAnalysis, allUnits: Unit[]): void {
    const playerUnits = allUnits.filter(u => u.faction === 'player');
    const hiddenUnits: Unit[] = [];

    for (const pu of playerUnits) {
      if (pu.revealed) {
        const pByType = this.createEmptyTypeMap();
        pByType[pu.type] = 1;
        analysis.beliefMap.set(pu.id, {
          pFlag: pu.type === 'flag' ? 1 : 0,
          pBomb: pu.type === 'bomb' ? 1 : 0,
          pByType,
          entropy: 0
        });
      } else {
        hiddenUnits.push(pu);
      }
    }

    if (hiddenUnits.length === 0) {
      const revFlag = playerUnits.find(u => u.revealed && u.type === 'flag') || null;
      analysis.mostLikelyFlagUnit = revFlag;
      return;
    }

    // Build initial likelihood matrix W[unitIdx][type]
    const matrix: Record<UnitType, number>[] = hiddenUnits.map(u =>
      this.computeRawLikelihoodWeights(u, analysis, allUnits)
    );

    // Run 8 iterations of Sinkhorn-Knopp Iterative Proportional Fitting:
    // 1. Normalize rows so each unit's probability distribution sums to 1.0
    // 2. Normalize columns so the sum of probabilities for type `t` across all hidden units equals `hiddenPool[t]`
    for (let iter = 0; iter < 8; iter++) {
      // Row normalization
      for (let i = 0; i < hiddenUnits.length; i++) {
        let rowSum = 0;
        for (const t of ORDERED_UNIT_TYPES) {
          rowSum += matrix[i][t];
        }
        if (rowSum > 1e-9) {
          for (const t of ORDERED_UNIT_TYPES) {
            matrix[i][t] /= rowSum;
          }
        }
      }

      // Column scaling to match exact remaining counts in hiddenPool
      for (const t of ORDERED_UNIT_TYPES) {
        const targetCount = analysis.hiddenPool[t];
        if (targetCount <= 0) {
          for (let i = 0; i < hiddenUnits.length; i++) {
            matrix[i][t] = 0;
          }
          continue;
        }
        let colSum = 0;
        for (let i = 0; i < hiddenUnits.length; i++) {
          colSum += matrix[i][t];
        }
        if (colSum > 1e-9) {
          const scale = targetCount / colSum;
          for (let i = 0; i < hiddenUnits.length; i++) {
            matrix[i][t] *= scale;
          }
        }
      }
    }

    // Final row normalization & Shannon Entropy computation
    let bestFlagProb = -1;
    let mostLikelyFlagUnit: Unit | null =
      playerUnits.find(u => u.revealed && u.type === 'flag') || null;

    for (let i = 0; i < hiddenUnits.length; i++) {
      const u = hiddenUnits[i];
      const row = matrix[i];
      let rowSum = 0;
      for (const t of ORDERED_UNIT_TYPES) {
        rowSum += row[t];
      }

      const pByType = this.createEmptyTypeMap();
      let entropy = 0;

      if (rowSum > 1e-9) {
        for (const t of ORDERED_UNIT_TYPES) {
          const p = row[t] / rowSum;
          pByType[t] = p;
          if (p > 1e-6) {
            entropy -= p * Math.log2(p);
          }
        }
      }

      const pFlag = pByType.flag;
      const pBomb = pByType.bomb;

      if (pFlag > bestFlagProb) {
        bestFlagProb = pFlag;
        mostLikelyFlagUnit = u;
      }

      analysis.beliefMap.set(u.id, {
        pFlag,
        pBomb,
        pByType,
        entropy
      });
    }

    analysis.mostLikelyFlagUnit = mostLikelyFlagUnit;
  }

  private createEmptyTypeMap(): Record<UnitType, number> {
    return {
      marshal: 0,
      general: 0,
      colonel: 0,
      major: 0,
      captain: 0,
      lieutenant: 0,
      sergeant: 0,
      miner: 0,
      scout: 0,
      spy: 0,
      bomb: 0,
      flag: 0
    };
  }

  private computeRawLikelihoodWeights(
    target: Unit,
    analysis: BoardAnalysis,
    allUnits: Unit[]
  ): Record<UnitType, number> {
    const weights = this.createEmptyTypeMap();
    const susp = this.suspicions.get(target.id);

    // 1. Immobile types (Flag & Bomb) are ONLY possible if !target.hasMovedEver
    if (!target.hasMovedEver) {
      let flagW = analysis.unrevealedFlag > 0 ? 1.0 : 0;
      let bombW = analysis.unrevealedBombs > 0 ? 1.0 : 0;

      if (target.r === 4) {
        flagW *= 3.2;
        bombW *= 1.65;
        // Corner hexes (0,4) and (-4,4) are prime Kingpin Citadel Flag locations!
        if (target.q === 0 || target.q === -4 || target.q === -1 || target.q === -3) {
          flagW *= target.q === 0 || target.q === -4 ? 1.85 : 1.25;
        }
      } else if (target.r === 3) {
        flagW *= 0.25;
        bombW *= 1.35;
      } else if (target.r === 2) {
        flagW *= 0.04;
        bombW *= 0.65;
      }

      const neighbors = getNeighbors(target.q, target.r);
      let adjRevealedBombs = 0;
      let adjUnmovedPlayer = 0;
      for (const n of neighbors) {
        const nu = allUnits.find(u => u.faction === 'player' && u.q === n.q && u.r === n.r);
        if (nu) {
          if (nu.revealed && nu.type === 'bomb') adjRevealedBombs++;
          if (!nu.hasMovedEver) adjUnmovedPlayer++;
        }
      }

      if (adjRevealedBombs > 0) {
        flagW *= 1 + adjRevealedBombs * 2.4;
        bombW *= 1 + adjRevealedBombs * 0.5;
      }
      if (target.r === 4 && adjUnmovedPlayer >= 2) {
        flagW *= 1.55;
        bombW *= 1.3;
      }

      weights.flag = flagW;
      weights.bomb = bombW;
    }

    // Check tactical context around `target` (adjacent revealed AI units or adjacent revealed Player officers)
    const targetNeighbors = getNeighbors(target.q, target.r);
    let maxAdjRevealedAiRank = 0;
    let adjToRevealedAiMarshal = false;
    let adjToRevealedPlayerHighOfficer = false;

    for (const tn of targetNeighbors) {
      const nu = allUnits.find(u => u.q === tn.q && u.r === tn.r);
      if (!nu) continue;
      if (nu.faction === 'ai' && nu.revealed) {
        const r = UNIT_DEFINITIONS[nu.type].rank;
        if (nu.type === 'marshal') adjToRevealedAiMarshal = true;
        else if (r >= 4 && r <= 9 && r > maxAdjRevealedAiRank) maxAdjRevealedAiRank = r;
      } else if (nu.faction === 'player' && nu.revealed) {
        const r = UNIT_DEFINITIONS[nu.type].rank;
        if (r >= 7 && r <= 9) adjToRevealedPlayerHighOfficer = true;
      }
    }

    // 2. Movable unit likelihoods
    for (const t of ORDERED_UNIT_TYPES) {
      if (t === 'flag' || t === 'bomb') continue;
      const count = analysis.hiddenPool[t];
      if (count <= 0) {
        weights[t] = 0;
        continue;
      }

      let w = 1.0;
      const rank = UNIT_DEFINITIONS[t].rank;

      if (susp) {
        if (rank < susp.minLikelyRank && t !== 'spy') {
          w *= 0.15;
        }
        if (rank > susp.maxLikelyRank) {
          w *= 0.15;
        }
        if (t === 'spy' && susp.spySuspicion > 0) {
          w *= 1 + susp.spySuspicion * 5.2;
        }
        if (t === 'miner' && susp.minerSuspicion > 0) {
          w *= 1 + susp.minerSuspicion * 4.0;
        }
        if (susp.approachedHighRank && rank >= 7) {
          w *= 2.1;
        }
        if (susp.targetedUnmovedBackrow && (t === 'miner' || t === 'scout' || t === 'sergeant')) {
          w *= 1.85;
        }
      }

      // Human behavioral context: standing next to a revealed AI officer or escorting a revealed Player General/Colonel
      if (target.hasMovedEver) {
        if (adjToRevealedAiMarshal) {
          if (t === 'spy') w *= 3.6;
          else if (t === 'marshal') w *= 1.8;
          else w *= 0.35;
        } else if (maxAdjRevealedAiRank >= 4) {
          if (rank > maxAdjRevealedAiRank) w *= 2.45;
          else if (rank === maxAdjRevealedAiRank) w *= 1.25;
          else if (t !== 'spy') w *= 0.28;
        }
      }
      if (adjToRevealedPlayerHighOfficer && t === 'spy') {
        w *= 2.65;
      }

      if (!target.hasMovedEver) {
        if (target.r === 4) {
          if (t === 'miner') w *= 1.65;
          if (t === 'major' || t === 'captain') w *= 1.35; // Goalie candidates
          if (t === 'scout') w *= 0.3;
        } else if (target.r === 3) {
          if (t === 'major' || t === 'spy' || t === 'general') w *= 1.35;
        }
      } else {
        // Unit has moved
        if (target.r <= 0 && (t === 'scout' || t === 'sergeant' || t === 'lieutenant' || t === 'captain' || t === 'colonel' || t === 'marshal' || t === 'general')) {
          w *= 1.25;
        }
        if (target.r <= -2 && t === 'miner') {
          // Deep infiltrator heading for AI bombs/flag
          w *= 1.8;
        }
      }

      weights[t] = w;
    }

    return weights;
  }

  /**
   * Returns the calibrated Bayesian probability distribution for an unrevealed player unit.
   */
  public getUnitBelief(target: Unit, analysis: BoardAnalysis, allUnits: Unit[]): UnitBelief {
    const cached = analysis.beliefMap.get(target.id);
    if (cached) {
      return cached;
    }

    // Fallback if target was not in analysis.beliefMap
    const pByType = this.createEmptyTypeMap();
    if (target.revealed) {
      pByType[target.type] = 1;
      return {
        pFlag: target.type === 'flag' ? 1 : 0,
        pBomb: target.type === 'bomb' ? 1 : 0,
        pByType,
        entropy: 0
      };
    }

    const raw = this.computeRawLikelihoodWeights(target, analysis, allUnits);
    let sum = 0;
    for (const t of ORDERED_UNIT_TYPES) {
      raw[t] *= analysis.hiddenPool[t];
      sum += raw[t];
    }
    let entropy = 0;
    if (sum > 0) {
      for (const t of ORDERED_UNIT_TYPES) {
        const p = raw[t] / sum;
        pByType[t] = p;
        if (p > 1e-6) entropy -= p * Math.log2(p);
      }
    }
    return {
      pFlag: pByType.flag,
      pBomb: pByType.bomb,
      pByType,
      entropy
    };
  }

  /**
   * Dynamic strategic value of a unit based on current board state & Game Theory dominance.
   */
  public getUnitValue(type: UnitType, faction: Faction, analysis: BoardAnalysis): number {
    if (type === 'flag') return 10000;
    if (type === 'bomb') return 320;

    if (faction === 'ai') {
      switch (type) {
        case 'marshal':
          return analysis.playerSpyAlive ? 920 : 1220;
        case 'general':
          return analysis.playerMarshalAlive ? 780 : 1150;
        case 'colonel':
          return !analysis.playerMarshalAlive && !analysis.playerGeneralAlive ? 980 : 560;
        case 'major':
          return 400;
        case 'captain':
          return 275;
        case 'lieutenant':
          return 185;
        case 'sergeant':
          return 135;
        case 'miner':
          if (analysis.unrevealedBombs === 0) {
            return 220;
          }
          if (analysis.aiMinersAlive === 1) return 880; // Protect the last Miner at all costs!
          if (analysis.aiMinersAlive === 2) return 520;
          return 360;
        case 'scout':
          return analysis.totalHiddenMovable > 6 ? 130 : 95;
        case 'spy':
          return analysis.playerMarshalAlive ? 540 : 75;
      }
    } else {
      switch (type) {
        case 'marshal':
          return 980;
        case 'general':
          return 810;
        case 'colonel':
          return 560;
        case 'major':
          return 415;
        case 'captain':
          return 285;
        case 'lieutenant':
          return 195;
        case 'sergeant':
          return 145;
        case 'miner':
          return analysis.playerMinersAlive <= 1
            ? 840
            : analysis.playerMinersAlive === 2
            ? 580
            : 410;
        case 'scout':
          return 135;
        case 'spy':
          return analysis.aiMarshalAlive ? 560 : 90;
      }
    }
  }

  /**
   * Computes a full single-source shortest-path distance map from `(startQ, startR)` to all hexes on the board
   * in one fast pass (~61 hexes), considering water, mountains, friendly Bombs/Flag, and enemy revealed Bombs.
   */
  public computeDistanceMapFrom(
    startQ: number,
    startR: number,
    mover: Unit,
    tiles: Map<string, HexTile>,
    allUnits: Unit[]
  ): Map<string, number> {
    const distMap = new Map<string, number>();
    const startKey = coordKey(startQ, startR);
    distMap.set(startKey, 0);

    const queue: { q: number; r: number; d: number }[] = [{ q: startQ, r: startR, d: 0 }];

    while (queue.length > 0) {
      queue.sort((a, b) => a.d - b.d);
      const curr = queue.shift()!;
      const currKey = coordKey(curr.q, curr.r);
      const bestKnown = distMap.get(currKey);
      if (bestKnown !== undefined && curr.d > bestKnown) continue;

      for (const n of getNeighbors(curr.q, curr.r)) {
        const nKey = coordKey(n.q, n.r);
        const tile = tiles.get(nKey);
        if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') continue;

        let stepCost = 1;
        const occ = allUnits.find(u => u.q === n.q && u.r === n.r && u.id !== mover.id);
        if (occ) {
          if (occ.faction === mover.faction) {
            if (!UNIT_DEFINITIONS[occ.type].canMove) {
              continue; // Friendly Bomb or Flag is permanently impassable
            }
            stepCost = 1.45; // Congestion penalty around friendly units
          } else {
            if (occ.revealed && occ.type === 'bomb' && mover.type !== 'miner') {
              continue; // Non-miners cannot path through a revealed enemy Bomb
            }
            stepCost = 1.3;
          }
        }

        const nextD = curr.d + stepCost;
        const prevBest = distMap.get(nKey);
        if (prevBest === undefined || nextD < prevBest) {
          distMap.set(nKey, nextD);
          queue.push({ q: n.q, r: n.r, d: nextD });
        }
      }
    }

    return distMap;
  }

  /**
   * Checks if a player unit `attacker` at its current position could legally attack `(targetQ, targetR)`
   * on the given board state `boardUnits`.
   */
  private canUnitReachSquareInOneTurn(
    attacker: Unit,
    targetQ: number,
    targetR: number,
    tiles: Map<string, HexTile>,
    boardUnits: Unit[]
  ): boolean {
    const dist = hexDistance({ q: attacker.q, r: attacker.r }, { q: targetQ, r: targetR });
    if (dist === 0) return false;

    if (attacker.revealed && !UNIT_DEFINITIONS[attacker.type].canMove) {
      return false;
    }

    if (dist === 1) {
      return true;
    }

    const canBeScout =
      (attacker.revealed && attacker.type === 'scout') || (!attacker.revealed && dist <= 4);
    if (!canBeScout || dist > 4) return false;

    for (const dir of HEX_DIRECTIONS) {
      for (let step = 1; step <= 4; step++) {
        const sq = attacker.q + dir.q * step;
        const sr = attacker.r + dir.r * step;
        if (sq === targetQ && sr === targetR) {
          return true;
        }
        const tile = tiles.get(coordKey(sq, sr));
        if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') break;
        const occ = boardUnits.find(u => u.q === sq && u.r === sr);
        if (occ) break;
      }
    }

    return false;
  }

  /**
   * Computes the expected loss / counter-attack danger for `aiUnit` standing at `(atQ, atR)`
   * when it is the player's turn next.
   */
  public evaluateCounterAttackRisk(
    aiUnit: Unit,
    atQ: number,
    atR: number,
    willBeRevealed: boolean,
    tiles: Map<string, HexTile>,
    boardUnits: Unit[],
    analysis: BoardAnalysis
  ): number {
    const myDef = UNIT_DEFINITIONS[aiUnit.type];
    const myVal = this.getUnitValue(aiUnit.type, 'ai', analysis);
    let maxRisk = 0;

    for (const pu of boardUnits) {
      if (pu.faction !== 'player') continue;
      if (pu.q === atQ && pu.r === atR) continue;

      if (!this.canUnitReachSquareInOneTurn(pu, atQ, atR, tiles, boardUnits)) {
        continue;
      }

      const dist = hexDistance({ q: pu.q, r: pu.r }, { q: atQ, r: atR });

      if (pu.revealed) {
        const puDef = UNIT_DEFINITIONS[pu.type];
        if (!puDef.canMove) continue;

        const spyKillsMarshal = pu.type === 'spy' && aiUnit.type === 'marshal';
        const higherRankKills = puDef.rank > myDef.rank;
        const equalRankTrades = puDef.rank === myDef.rank;

        if (spyKillsMarshal || higherRankKills) {
          const certainty = willBeRevealed || puDef.rank >= 8 || spyKillsMarshal ? 0.96 : 0.75;
          maxRisk = Math.max(maxRisk, myVal * certainty);
        } else if (equalRankTrades && willBeRevealed) {
          const puVal = this.getUnitValue(pu.type, 'player', analysis);
          if (myVal > puVal) {
            maxRisk = Math.max(maxRisk, (myVal - puVal) * 0.65);
          }
        }
      } else {
        const belief = this.getUnitBelief(pu, analysis, boardUnits);

        if (dist > 1) {
          if (aiUnit.type === 'spy') {
            const pScout = belief.pByType.scout;
            maxRisk = Math.max(maxRisk, pScout * myVal * 0.9);
          }
          continue;
        }

        let probBeatsMe = 0;
        let probEqualsMe = 0;
        for (const t of ORDERED_UNIT_TYPES) {
          if (t === 'flag' || t === 'bomb') continue;
          const p = belief.pByType[t];
          if (p <= 0) continue;
          const r = UNIT_DEFINITIONS[t].rank;
          if (t === 'spy' && aiUnit.type === 'marshal') {
            probBeatsMe += p;
          } else if (r > myDef.rank) {
            probBeatsMe += p;
          } else if (r === myDef.rank) {
            probEqualsMe += p;
          }
        }

        const puSusp = this.suspicions.get(pu.id);
        // If our AI unit is ALREADY revealed and an unrevealed moved player unit is right next to it,
        // a human player rarely leaves a weaker piece adjacent to a known AI officer—calibrate for human hunting intent!
        if (aiUnit.revealed && pu.hasMovedEver && myDef.rank >= 5) {
          const intentFloor = puSusp?.approachedHighRank ? 0.74 : 0.56;
          if (probBeatsMe > 0.04) {
            probBeatsMe = Math.min(0.92, Math.max(probBeatsMe * 1.55, intentFloor));
          }
        }

        const multiplier = willBeRevealed ? 0.95 : 0.52;
        let risk = (probBeatsMe + probEqualsMe * 0.25) * myVal * multiplier;

        // Anti-Spy-Bait Protection for AI Marshal (10):
        // Humans love baiting the AI Marshal with a revealed General (9) / Colonel (8) / Major (7) that has an unrevealed Spy (1) right next to it!
        if (aiUnit.type === 'marshal' && willBeRevealed && analysis.playerSpyAlive && !analysis.playerSpyRevealed) {
          const spyProb = belief.pByType.spy;
          const suspSpy = puSusp?.spySuspicion ?? 0;
          let spyTrapDanger = spyProb * myVal * 1.35;
          if (pu.hasMovedEver && (spyProb >= 0.12 || suspSpy >= 0.2)) {
            spyTrapDanger = Math.max(spyTrapDanger, myVal * Math.min(0.85, 0.38 + spyProb * 1.6 + suspSpy * 0.45));
          }
          risk = Math.max(risk, spyTrapDanger);
        }

        maxRisk = Math.max(maxRisk, risk);
      }
    }

    return maxRisk;
  }

  /**
   * Computes a compact board signature to detect when the board position has changed.
   */
  public computeBoardSignature(
    units: Unit[],
    sideToMove: Faction,
    difficulty: AIDifficulty,
    gameMode: GameMode
  ): string {
    const parts: string[] = [sideToMove, difficulty, gameMode];
    for (const u of units) {
      parts.push(`${u.id}@${u.q},${u.r}:${u.type}:${u.revealed ? 1 : 0}:${u.xp ?? 0}`);
    }
    return parts.join('|');
  }

  /**
   * Fast 32-bit FNV-1a / Zobrist-style hash for a determinized world state + sideToMove + worldIdx.
   */
  private computeWorldHash(worldUnits: Unit[], sideToMove: Faction, worldIdx: number): number {
    let h = 2166136261 ^ (sideToMove === 'ai' ? 0x9e3779b9 : 0x7f4a7c15) ^ (worldIdx * 0x85ebca6b);
    for (let i = 0; i < worldUnits.length; i++) {
      const u = worldUnits[i];
      const rankCode = UNIT_DEFINITIONS[u.type].rank + (u.faction === 'ai' ? 16 : 0);
      const coordCode = ((u.q + 8) << 5) | (u.r + 8);
      const revCode = u.revealed ? 0x1000 : 0;
      const mix = (rankCode << 14) ^ coordCode ^ revCode ^ ((u.xp ?? 0) << 20);
      h ^= mix;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Converts raw AI evaluation score into Player-centric strategic score (in 100-pt pawn equivalents)
   * and Player Win Probability (0..100%).
   */
  public computeEvalMetrics(aiRawScore: number, units?: Unit[]): { evalForPlayer: number; playerWinProb: number } {
    let raw = aiRawScore;
    if (!Number.isFinite(raw)) {
      raw = 0;
    }
    // If raw is near zero and units are provided, compute baseline static eval
    if (Math.abs(raw) < 1 && units && units.length > 0) {
      const analysis = this.analyzeBoard(units);
      const worlds = this.buildDeterminizedWorlds(units, analysis);
      raw = this.evaluateWorldState(worlds[0], 'player', analysis);
    }
    const evalForPlayer = Number((-raw / 150).toFixed(2));
    // Logistic win probability curve
    const clamped = Math.max(-18, Math.min(18, evalForPlayer));
    const playerWinProb = Math.round(100 / (1 + Math.exp(-0.28 * clamped)));
    return { evalForPlayer, playerWinProb };
  }

  /**
   * Formats a move as a human-readable tactical string, e.g. "AUF (0,2→0,0)"
   */
  public formatMoveLabel(unit: Unit | undefined, toQ: number, toR: number, isMaskedForPlayer = false): string {
    if (!unit) return `(?→${toQ},${toR})`;
    const shortName =
      isMaskedForPlayer && !unit.revealed ? '?' : UNIT_DEFINITIONS[unit.type].shortName;
    return `${shortName}(${unit.q},${unit.r}→${toQ},${toR})`;
  }

  /**
   * Extracts the Principal Variation (PV) multi-move sequence from the Transposition Table.
   */
  private extractPVLine(
    worldUnits: Unit[],
    sideToMove: Faction,
    worldIdx: number,
    tiles: Map<string, HexTile>,
    gameMode: GameMode,
    maxPlies = 5
  ): string {
    const steps: string[] = [];
    let currUnits = worldUnits;
    let currSide = sideToMove;

    for (let ply = 0; ply < maxPlies; ply++) {
      const h = this.computeWorldHash(currUnits, currSide, worldIdx);
      const entry = this.ttMap.get(h);
      if (!entry || !entry.bestUnitId) break;

      const mover = currUnits.find(u => u.id === entry.bestUnitId);
      if (!mover) break;

      const prefix = currSide === 'ai' ? '🔴' : '🔵';
      // Do not leak hidden AI unit types in the UI PV line unless revealed
      const maskAI = currSide === 'ai' && !mover.revealed;
      steps.push(`${prefix}${this.formatMoveLabel(mover, entry.bestToQ, entry.bestToR, maskAI)}`);

      const sim = this.applyMoveInWorld(
        currUnits,
        entry.bestUnitId,
        entry.bestToQ,
        entry.bestToR,
        tiles,
        gameMode
      );
      if (sim.terminalWinner) break;
      currUnits = sim.nextUnits;
      currSide = currSide === 'ai' ? 'player' : 'ai';
    }

    return steps.join(' → ');
  }

  /**
   * Continuous Non-Blocking Background Pondering ("Permanent Brain"):
   * Called every animation frame (~16-25ms) even when it is NOT the AI's turn
   * (during setup, player_turn, animating_move, combat_anim, and ai_turn).
   * Continuously deepens the Iterative Deepening search tree (Depth 2 -> 4 -> 6 -> 8 -> 10 -> 12 -> 16+ plies)
   * and populates the persistent Zobrist Transposition Table & Ponder Counter-Move Book!
   */
  public stepPonderSlice(
    units: Unit[],
    tiles: Map<string, HexTile>,
    phase: string,
    turn: number,
    difficulty: AIDifficulty,
    getValidMovesFn: (u: Unit) => AxialCoord[],
    gameMode: GameMode = 'classic',
    sliceBudgetMs = 11
  ): boolean {
    if (phase === 'game_over' || units.length === 0) return false;

    const sideToMove: Faction = phase === 'ai_turn' ? 'ai' : 'player';
    const ponderPhase: 'setup_analysis' | 'pondering_player' | 'thinking_ai' =
      phase === 'setup'
        ? 'setup_analysis'
        : phase === 'ai_turn'
        ? 'thinking_ai'
        : 'pondering_player';

    const boardSig = this.computeBoardSignature(units, sideToMove, difficulty, gameMode);

    // Prune Transposition Table if it grows beyond 90,000 entries
    if (this.ttMap.size > 90000) {
      for (const [k, v] of this.ttMap) {
        if (v.age < this.ttAge - 1 && v.depth <= 3) {
          this.ttMap.delete(k);
        }
      }
      if (this.ttMap.size > 85000) {
        this.ttMap.clear();
      }
    }

    // Initialize or reset the pondering session if the board position changed
    if (!this.ponderSession || this.ponderSession.boardSignature !== boardSig) {
      const analysis = this.analyzeBoard(units);
      const worlds = this.buildDeterminizedWorlds(units, analysis);
      const worldWeights = worlds.length === 4 ? [0.45, 0.25, 0.15, 0.15] : [1.0];

      let rootMoves: { unit: Unit; toQ: number; toR: number; baseScore: number }[] = [];

      if (sideToMove === 'ai') {
        const aiMovable = units.filter(u => u.faction === 'ai' && UNIT_DEFINITIONS[u.type].canMove);
        const currentUnitDanger = new Map<string, number>();
        const unitStartDistMap = new Map<string, Map<string, number>>();
        for (const au of aiMovable) {
          currentUnitDanger.set(
            au.id,
            this.evaluateCounterAttackRisk(au, au.q, au.r, au.revealed, tiles, units, analysis)
          );
          unitStartDistMap.set(au.id, this.computeDistanceMapFrom(au.q, au.r, au, tiles, units));
        }

        for (const u of aiMovable) {
          const vMoves = getValidMovesFn(u);
          const sDists = unitStartDistMap.get(u.id)!;
          for (const m of vMoves) {
            const sc = this.evaluateMove(
              u,
              m.q,
              m.r,
              units,
              tiles,
              turn,
              difficulty,
              analysis,
              currentUnitDanger,
              sDists,
              gameMode
            );
            rootMoves.push({ unit: u, toQ: m.q, toR: m.r, baseScore: sc });
          }
        }
        rootMoves.sort((a, b) => b.baseScore - a.baseScore);
        const viableMoves = rootMoves.filter(m => m.baseScore > -8000);
        rootMoves = (viableMoves.length > 0 ? viableMoves : rootMoves).slice(0, 18);
      } else {
        // Player is to move (or in setup): generate the player's strongest candidate moves to ponder against!
        const orderedPlayerMoves = this.generateOrderedWorldMoves(
          worlds[0],
          'player',
          tiles,
          false,
          16,
          undefined,
          1,
          analysis
        );
        for (const pm of orderedPlayerMoves) {
          const realUnit = units.find(u => u.id === pm.unitId);
          if (realUnit) {
            rootMoves.push({
              unit: realUnit,
              toQ: pm.toQ,
              toR: pm.toR,
              baseScore: pm.orderScore
            });
          }
        }
      }

      const initialStaticScore =
        worlds.length > 0 ? this.evaluateWorldState(worlds[0], sideToMove, analysis) : 0;

      this.ponderSession = {
        boardSignature: boardSig,
        sideToMove,
        phase: ponderPhase,
        turn,
        difficulty,
        gameMode,
        startTime: performance.now(),
        analysis,
        worlds,
        worldWeights,
        rootMoves,
        currentDepth: 2, // Starts at 2 tree plies (+1 root +3 quiescence = 6 plies) and deepens up to 16+ plies!
        quiescenceDepth: 3,
        completedDepth: 1,
        candIdx: 0,
        worldIdx: 0,
        candExpectedScore: 0,
        candWorstScore: sideToMove === 'ai' ? Infinity : -Infinity,
        initialStaticScore,
        bestMoveAtCurrentDepth: rootMoves[0]
          ? { unit: rootMoves[0].unit, toQ: rootMoves[0].toQ, toR: rootMoves[0].toR, score: initialStaticScore }
          : null,
        bestScoreAtCurrentDepth: sideToMove === 'ai' ? -Infinity : Infinity,
        committedBestMove: rootMoves[0]
          ? { unit: rootMoves[0].unit, toQ: rootMoves[0].toQ, toR: rootMoves[0].toR, score: initialStaticScore }
          : null,
        committedBestScore: initialStaticScore,
        predictedPlayerMoveText: 'Analysiere Frontlinie...',
        plannedCounterMoveText: 'Berechne Konter...',
        pvLineText: '',
        sessionNodes: 0
      };
    }

    const s = this.ponderSession;
    if (s.rootMoves.length === 0) return false;

    // Max iterative depth: up to 15 tree plies (+1 root +3 quiescence = 19 Halbzüge im Voraus!)
    const maxTreeDepth = difficulty === 'ultra' ? 15 : difficulty === 'hard' ? 8 : 5;
    if (s.currentDepth > maxTreeDepth) {
      return false; // Already reached maximum deep horizon for this board state
    }

    const sliceStart = performance.now();
    const sliceEnd = sliceStart + sliceBudgetMs;
    let madeUIUpdate = false;

    while (performance.now() < sliceEnd && s.currentDepth <= maxTreeDepth) {
      const cand = s.rootMoves[s.candIdx];
      const wIdx = s.worldIdx;
      const worldUnits = s.worlds[wIdx];

      this.searchNodesCount = 0;
      // Allow enough headroom so a single (cand, world) node finishes cleanly
      this.searchDeadline = performance.now() + Math.max(sliceBudgetMs + 8, 22);

      const simResult = this.applyMoveInWorld(
        worldUnits,
        cand.unit.id,
        cand.toQ,
        cand.toR,
        tiles,
        s.gameMode
      );

      let wScore: number;
      if (simResult.terminalWinner === 'ai') {
        wScore = 45000 + s.currentDepth * 300;
      } else if (simResult.terminalWinner === 'player') {
        wScore = -45000 - s.currentDepth * 300;
      } else {
        const nextSide: Faction = s.sideToMove === 'ai' ? 'player' : 'ai';
        wScore = this.alphaBetaSearch(
          simResult.nextUnits,
          s.currentDepth,
          s.quiescenceDepth,
          -50000,
          50000,
          nextSide,
          tiles,
          s.analysis,
          s.gameMode,
          wIdx,
          1
        );
      }

      s.sessionNodes += this.searchNodesCount;
      this.totalNodesAllTime += this.searchNodesCount;

      const weight = s.worldWeights[wIdx] ?? 1 / s.worlds.length;
      s.candExpectedScore += wScore * weight;
      if (s.sideToMove === 'ai') {
        if (wScore < s.candWorstScore) s.candWorstScore = wScore;
      } else {
        if (wScore > s.candWorstScore) s.candWorstScore = wScore;
      }

      // If pondering a player move in World 0 (MAP world), record the AI's optimal response from the TT!
      if (s.sideToMove === 'player' && wIdx === 0 && !simResult.terminalWinner) {
        const childHash = this.computeWorldHash(simResult.nextUnits, 'ai', 0);
        const replyTT = this.ttMap.get(childHash);
        if (replyTT && replyTT.bestUnitId) {
          const pvStr = this.extractPVLine(simResult.nextUnits, 'ai', 0, tiles, s.gameMode, 4);
          const pmKey = `${cand.unit.id}:${cand.toQ},${cand.toR}`;
          this.ponderResponseBook.set(pmKey, {
            aiUnitId: replyTT.bestUnitId,
            toQ: replyTT.bestToQ,
            toR: replyTT.bestToR,
            score: wScore,
            depth: s.currentDepth + 1 + s.quiescenceDepth,
            pvText: pvStr
          });
        }
      }

      s.worldIdx++;

      // Finished all Bayesian worlds for this root candidate move?
      if (s.worldIdx >= s.worlds.length) {
        if (s.sideToMove === 'ai') {
          const expectedDelta = s.candExpectedScore - s.initialStaticScore;
          const worstDelta = s.candWorstScore - s.initialStaticScore;
          const regretAdjustedDelta = 0.68 * expectedDelta + 0.32 * worstDelta;
          const treeWeight = worstDelta < -220 || regretAdjustedDelta < -140 ? 0.80 : 0.64;
          const combined = cand.baseScore * (1 - treeWeight) + regretAdjustedDelta * treeWeight;
          if (combined > s.bestScoreAtCurrentDepth) {
            s.bestScoreAtCurrentDepth = combined;
            s.bestMoveAtCurrentDepth = {
              unit: cand.unit,
              toQ: cand.toQ,
              toR: cand.toR,
              score: s.initialStaticScore + regretAdjustedDelta
            };
          }
        } else {
          // Player minimizes AI score
          const playerScore = 0.72 * s.candExpectedScore + 0.28 * s.candWorstScore;
          if (playerScore < s.bestScoreAtCurrentDepth) {
            s.bestScoreAtCurrentDepth = playerScore;
            s.bestMoveAtCurrentDepth = {
              unit: cand.unit,
              toQ: cand.toQ,
              toR: cand.toR,
              score: playerScore
            };
          }
        }

        // Advance to next candidate move
        s.candIdx++;
        s.worldIdx = 0;
        s.candExpectedScore = 0;
        s.candWorstScore = s.sideToMove === 'ai' ? Infinity : -Infinity;

        // Finished all candidates at `s.currentDepth`! Commit this Iterative Deepening level!
        if (s.candIdx >= s.rootMoves.length) {
          const totalPlyHorizon = s.currentDepth + 1 + s.quiescenceDepth;
          s.completedDepth = totalPlyHorizon;
          if (s.bestMoveAtCurrentDepth) {
            s.committedBestMove = { ...s.bestMoveAtCurrentDepth };
            s.committedBestScore = s.bestMoveAtCurrentDepth.score;

            // Re-order rootMoves so the best move from depth D is searched first at depth D+1 (PV ordering!)
            const bestId = s.committedBestMove.unit.id;
            const bQ = s.committedBestMove.toQ;
            const bR = s.committedBestMove.toR;
            const idx = s.rootMoves.findIndex(
              rm => rm.unit.id === bestId && rm.toQ === bQ && rm.toR === bR
            );
            if (idx > 0) {
              const [top] = s.rootMoves.splice(idx, 1);
              s.rootMoves.unshift(top);
            }

            // Build PV & Ponder texts
            if (s.sideToMove === 'player') {
              s.predictedPlayerMoveText = `🔵 ${this.formatMoveLabel(
                s.committedBestMove.unit,
                bQ,
                bR,
                false
              )}`;
              const replyKey = `${bestId}:${bQ},${bR}`;
              const reply = this.ponderResponseBook.get(replyKey);
              if (reply) {
                const aiUnit = units.find(u => u.id === reply.aiUnitId);
                s.plannedCounterMoveText = `🔴 ${this.formatMoveLabel(
                  aiUnit,
                  reply.toQ,
                  reply.toR,
                  true
                )}`;
                s.pvLineText = `${s.predictedPlayerMoveText} → ${reply.pvText}`;
              } else {
                s.pvLineText = s.predictedPlayerMoveText;
              }
            } else {
              const sim0 = this.applyMoveInWorld(
                s.worlds[0],
                bestId,
                bQ,
                bR,
                tiles,
                s.gameMode
              );
              const firstStep = `🔴 ${this.formatMoveLabel(
                s.committedBestMove.unit,
                bQ,
                bR,
                true
              )}`;
              const restPV = sim0.terminalWinner
                ? '🏆 Sieg'
                : this.extractPVLine(sim0.nextUnits, 'player', 0, tiles, s.gameMode, 4);
              s.plannedCounterMoveText = firstStep;
              s.pvLineText = restPV ? `${firstStep} → ${restPV}` : firstStep;
            }
          }

          // Advance Iterative Deepening to next deeper ply!
          s.currentDepth++;
          s.candIdx = 0;
          s.bestMoveAtCurrentDepth = null;
          s.bestScoreAtCurrentDepth = s.sideToMove === 'ai' ? -Infinity : Infinity;
          madeUIUpdate = true;
        }
      }
    }

    // Update live telemetry stats
    const elapsedMs = Math.max(1, Math.round(performance.now() - s.startTime));
    const nps = Math.round((s.sessionNodes / elapsedMs) * 1000);
    const { evalForPlayer, playerWinProb } = this.computeEvalMetrics(s.committedBestScore, units);

    this.lastSearchStats = {
      difficulty,
      isPondering: s.currentDepth <= maxTreeDepth,
      ponderPhase: s.phase,
      depthReached: Math.max(s.completedDepth, 4),
      targetDepth: Math.min(maxTreeDepth + 1 + s.quiescenceDepth, s.currentDepth + 1 + s.quiescenceDepth),
      quiescenceDepth: s.quiescenceDepth,
      nodesEvaluated: s.sessionNodes,
      totalNodesAllTime: this.totalNodesAllTime,
      nodesPerSecond: nps,
      ttHits: this.ttHits,
      ttSize: this.ttMap.size,
      worldsSampled: s.worlds.length,
      bestScore: Math.round(s.committedBestScore),
      evalForPlayer,
      playerWinProb,
      timeMs: elapsedMs,
      predictedPlayerMove: s.predictedPlayerMoveText,
      plannedCounterMove: s.plannedCounterMoveText,
      pvLine: s.pvLineText || 'Berechne Hauptvariante (PV)...',
      tacticalSummary:
        s.phase === 'pondering_player'
          ? `Permanent-Pondering während Spielerzug • Tiefe ${Math.max(s.completedDepth, 4)} Halbzüge`
          : s.phase === 'setup_analysis'
          ? `Vorab-Analyse der Aufstellung • Tiefe ${Math.max(s.completedDepth, 4)} Halbzüge`
          : `KI-Tiefensuche • Tiefe ${Math.max(s.completedDepth, 4)} Halbzüge`
    };

    return madeUIUpdate;
  }

  /**
   * Main entry point to select the strongest AI move.
   * Leverages the Persistent Zobrist Transposition Table & Ponder Counter-Move Book built
   * while the player was thinking, and runs further Iterative Deepening before moving!
   */
  public selectBestMove(
    units: Unit[],
    tiles: Map<string, HexTile>,
    turn: number,
    difficulty: AIDifficulty,
    getValidMovesFn: (u: Unit) => AxialCoord[],
    gameMode: GameMode = 'classic'
  ): { unit: Unit; toQ: number; toR: number } | null {
    const startTime = performance.now();
    const analysis = this.analyzeBoard(units);
    const aiMovableUnits = units.filter(u => u.faction === 'ai' && UNIT_DEFINITIONS[u.type].canMove);

    const currentUnitDanger = new Map<string, number>();
    const unitStartDistMap = new Map<string, Map<string, number>>();

    for (const au of aiMovableUnits) {
      const danger = this.evaluateCounterAttackRisk(
        au,
        au.q,
        au.r,
        au.revealed,
        tiles,
        units,
        analysis
      );
      currentUnitDanger.set(au.id, danger);
      unitStartDistMap.set(au.id, this.computeDistanceMapFrom(au.q, au.r, au, tiles, units));
    }

    const candidates: { unit: Unit; toQ: number; toR: number; score: number }[] = [];

    // Check if the player's last move has a pre-computed deep counter-move in `ponderResponseBook`
    const precomputedReply = this.lastKnownPlayerMoveKey
      ? this.ponderResponseBook.get(this.lastKnownPlayerMoveKey)
      : undefined;

    for (const unit of aiMovableUnits) {
      const validMoves = getValidMovesFn(unit);
      const startDists = unitStartDistMap.get(unit.id)!;
      for (const move of validMoves) {
        let score = this.evaluateMove(
          unit,
          move.q,
          move.r,
          units,
          tiles,
          turn,
          difficulty,
          analysis,
          currentUnitDanger,
          startDists,
          gameMode
        );
        // Boost move if our Permanent-Brain Ponder Book already identified it as the best counter!
        if (
          precomputedReply &&
          precomputedReply.aiUnitId === unit.id &&
          precomputedReply.toQ === move.q &&
          precomputedReply.toR === move.r
        ) {
          score += 120;
        }
        candidates.push({ unit, toQ: move.q, toR: move.r, score });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);

    // Immediate win check (capturing revealed Flag)
    if (candidates[0].score >= 45000) {
      const { evalForPlayer, playerWinProb } = this.computeEvalMetrics(45000, units);
      this.lastSearchStats = {
        difficulty,
        isPondering: false,
        ponderPhase: 'thinking_ai',
        depthReached: 1,
        targetDepth: 1,
        quiescenceDepth: 0,
        nodesEvaluated: candidates.length,
        totalNodesAllTime: this.totalNodesAllTime + candidates.length,
        nodesPerSecond: 50000,
        ttHits: this.ttHits,
        ttSize: this.ttMap.size,
        worldsSampled: 1,
        bestScore: Math.round(candidates[0].score),
        evalForPlayer,
        playerWinProb,
        timeMs: Math.round(performance.now() - startTime),
        predictedPlayerMove: '-',
        plannedCounterMove: `🔴 ${this.formatMoveLabel(candidates[0].unit, candidates[0].toQ, candidates[0].toR, false)}`,
        pvLine: 'Direkter Sieg: Flaggeneroberung!',
        tacticalSummary: 'Direkter Sieg: Flaggeneroberung!'
      };
      return candidates[0];
    }

    // Run additional Iterative Deepening slices right now (using the hot Transposition Table from pondering!)
    const timeBudget = difficulty === 'ultra' ? 280 : difficulty === 'hard' ? 140 : 60;
    const deadline = startTime + timeBudget;
    while (performance.now() < deadline) {
      this.stepPonderSlice(units, tiles, 'ai_turn', turn, difficulty, getValidMovesFn, gameMode, 25);
      if (this.ponderSession && this.ponderSession.currentDepth > 15) break;
    }

    if (this.ponderSession && this.ponderSession.sideToMove === 'ai' && this.ponderSession.committedBestMove) {
      const bm = this.ponderSession.committedBestMove;
      const valid = candidates.find(
        c => c.unit.id === bm.unit.id && c.toQ === bm.toQ && c.toR === bm.toR
      );
      if (valid) {
        return valid;
      }
    }

    return candidates[0];
  }

  /**
   * Builds 4 consistent determinized board states (Information Set samples) where every
   * unrevealed player unit is assigned a concrete UnitType matching `analysis.hiddenPool`.
   */
  private buildDeterminizedWorlds(units: Unit[], analysis: BoardAnalysis): Unit[][] {
    const hiddenUnits = units.filter(u => u.faction === 'player' && !u.revealed);
    if (hiddenUnits.length === 0) {
      return [units.map(u => ({ ...u }))];
    }

    // World 0: MAP (Maximum A Posteriori) assignment
    const mapAssignment = this.assignHiddenTypesGreedy(hiddenUnits, analysis, 'map', units);
    // World 1: Adversarial Trap assignment (emphasizes Spy near AI Marshal, Bombs in path, Miners near AI Flag)
    const advAssignment = this.assignHiddenTypesGreedy(hiddenUnits, analysis, 'adversarial', units);
    // World 2: Flank Breakthrough assignment (emphasizes high-rank attackers on the wings)
    const flankAssignment = this.assignHiddenTypesGreedy(hiddenUnits, analysis, 'flank', units);
    // World 3: Diversified Plausible assignment
    const divAssignment = this.assignHiddenTypesGreedy(hiddenUnits, analysis, 'diversified', units);

    const buildWorld = (assignment: Map<string, UnitType>): Unit[] =>
      units.map(u => {
        if (u.faction === 'player' && !u.revealed) {
          const assignedType = assignment.get(u.id) || u.type;
          return { ...u, type: assignedType };
        }
        return { ...u };
      });

    return [
      buildWorld(mapAssignment),
      buildWorld(advAssignment),
      buildWorld(flankAssignment),
      buildWorld(divAssignment)
    ];
  }

  private assignHiddenTypesGreedy(
    hiddenUnits: Unit[],
    analysis: BoardAnalysis,
    mode: 'map' | 'adversarial' | 'flank' | 'diversified',
    allUnits: Unit[]
  ): Map<string, UnitType> {
    const assignment = new Map<string, UnitType>();
    const remainingCounts: Record<UnitType, number> = { ...analysis.hiddenPool };
    const unassignedIds = new Set(hiddenUnits.map(u => u.id));

    const aiMarshal = allUnits.find(u => u.faction === 'ai' && u.type === 'marshal');
    const aiGeneral = allUnits.find(u => u.faction === 'ai' && u.type === 'general');
    const aiFlag = analysis.aiFlag;

    // 1. First assign immobile units (Flag & Bombs) only to unmoved hidden units (`!u.hasMovedEver`)
    const unmovedCandidates = hiddenUnits.filter(u => !u.hasMovedEver);
    for (const immobileType of ['flag', 'bomb'] as UnitType[]) {
      while (remainingCounts[immobileType] > 0) {
        let bestUnit: Unit | null = null;
        let bestWeight = -1;

        for (const u of unmovedCandidates) {
          if (!unassignedIds.has(u.id)) continue;
          const belief = analysis.beliefMap.get(u.id);
          let w = belief ? belief.pByType[immobileType] : 0.01;

          if (mode === 'adversarial' && immobileType === 'bomb') {
            const adjAi = allUnits.some(
              au => au.faction === 'ai' && hexDistance({ q: au.q, r: au.r }, { q: u.q, r: u.r }) === 1
            );
            if (adjAi) w += 0.45;
          } else if (mode === 'flank' && immobileType === 'flag') {
            if (u.r === 4 && Math.abs(u.q) >= 2) w += 0.35;
          } else if (mode === 'diversified' && immobileType === 'flag') {
            if (u.r === 4) w = (w + 0.25) * (0.7 + ((u.q * 17 + 31) % 7) * 0.08);
          }

          if (w > bestWeight) {
            bestWeight = w;
            bestUnit = u;
          }
        }

        if (!bestUnit) break;
        assignment.set(bestUnit.id, immobileType);
        unassignedIds.delete(bestUnit.id);
        remainingCounts[immobileType]--;
      }
    }

    // 2. Assign movable hidden units from highest strategic impact to lowest
    const movableOrder: UnitType[] = [
      'spy',
      'marshal',
      'general',
      'miner',
      'colonel',
      'major',
      'scout',
      'captain',
      'lieutenant',
      'sergeant'
    ];

    for (const mType of movableOrder) {
      while (remainingCounts[mType] > 0) {
        let bestUnit: Unit | null = null;
        let bestWeight = -1;

        for (const u of hiddenUnits) {
          if (!unassignedIds.has(u.id)) continue;
          const belief = analysis.beliefMap.get(u.id);
          let w = belief ? belief.pByType[mType] : 0.01;

          if (mode === 'adversarial') {
            if (mType === 'spy' && aiMarshal) {
              const d = hexDistance({ q: u.q, r: u.r }, { q: aiMarshal.q, r: aiMarshal.r });
              if (d <= 2) w += (3 - d) * 0.55;
            } else if (mType === 'marshal' && aiGeneral) {
              const d = hexDistance({ q: u.q, r: u.r }, { q: aiGeneral.q, r: aiGeneral.r });
              if (d <= 2) w += (3 - d) * 0.45;
            } else if (mType === 'miner' && aiFlag) {
              const d = hexDistance({ q: u.q, r: u.r }, { q: aiFlag.q, r: aiFlag.r });
              if (d <= 4) w += (5 - d) * 0.35;
            }
          } else if (mode === 'flank') {
            if ((mType === 'marshal' || mType === 'general' || mType === 'colonel') && u.r <= 1) {
              w += 0.4;
            }
          } else if (mode === 'diversified') {
            const hash = Math.abs((u.q * 37 + u.r * 13 + mType.charCodeAt(0)) % 11) / 11;
            w = w * 0.75 + hash * 0.25;
          }

          if (w > bestWeight) {
            bestWeight = w;
            bestUnit = u;
          }
        }

        if (!bestUnit) break;
        assignment.set(bestUnit.id, mType);
        unassignedIds.delete(bestUnit.id);
        remainingCounts[mType]--;
      }
    }

    return assignment;
  }

  /**
   * Deep Principal Variation Search (PVS / Alpha-Beta) with:
   * - Persistent Zobrist Transposition Table (TT) lookup & store
   * - Killer Move & History Heuristics
   * - Late Move Reductions (LMR) for deep lookahead (up to 15+3 = 18+ plies!)
   * - Quiescence Search on tactical captures/threats
   */
  private alphaBetaSearch(
    worldUnits: Unit[],
    depth: number,
    quiescenceDepth: number,
    alpha: number,
    beta: number,
    sideToMove: Faction,
    tiles: Map<string, HexTile>,
    rootAnalysis: BoardAnalysis,
    gameMode: GameMode,
    worldIdx = 0,
    ply = 1
  ): number {
    this.searchNodesCount++;

    // Time budget safeguard
    if ((this.searchNodesCount & 31) === 0 && performance.now() > this.searchDeadline) {
      return this.evaluateWorldState(worldUnits, sideToMove, rootAnalysis);
    }

    const origAlpha = alpha;
    const origBeta = beta;
    const stateHash = this.computeWorldHash(worldUnits, sideToMove, worldIdx);
    const ttEntry = this.ttMap.get(stateHash);

    if (ttEntry && ttEntry.depth >= depth) {
      this.ttHits++;
      if (ttEntry.flag === 0) {
        return ttEntry.score;
      } else if (ttEntry.flag === 1) {
        if (ttEntry.score > alpha) alpha = ttEntry.score;
      } else if (ttEntry.flag === 2) {
        if (ttEntry.score < beta) beta = ttEntry.score;
      }
      if (alpha >= beta) {
        return ttEntry.score;
      }
    }

    if (depth <= 0) {
      const standPat = this.evaluateWorldState(worldUnits, sideToMove, rootAnalysis);
      if (quiescenceDepth <= 0) {
        return standPat;
      }

      // Quiescence Search: only explore high-impact tactical captures!
      if (sideToMove === 'ai') {
        if (standPat >= beta) return beta;
        if (standPat > alpha) alpha = standPat;

        const tacticalMoves = this.generateOrderedWorldMoves(
          worldUnits,
          'ai',
          tiles,
          true,
          8,
          ttEntry,
          ply,
          rootAnalysis
        );
        for (const tm of tacticalMoves) {
          const res = this.applyMoveInWorld(worldUnits, tm.unitId, tm.toQ, tm.toR, tiles, gameMode);
          const score =
            res.terminalWinner === 'ai'
              ? 44000 + quiescenceDepth * 200
              : res.terminalWinner === 'player'
              ? -44000 - quiescenceDepth * 200
              : this.alphaBetaSearch(
                  res.nextUnits,
                  0,
                  quiescenceDepth - 1,
                  alpha,
                  beta,
                  'player',
                  tiles,
                  rootAnalysis,
                  gameMode,
                  worldIdx,
                  ply + 1
                );
          if (score > alpha) alpha = score;
          if (alpha >= beta) break;
        }
        return alpha;
      } else {
        if (standPat <= alpha) return alpha;
        if (standPat < beta) beta = standPat;

        const tacticalMoves = this.generateOrderedWorldMoves(
          worldUnits,
          'player',
          tiles,
          true,
          8,
          ttEntry,
          ply,
          rootAnalysis
        );
        for (const tm of tacticalMoves) {
          const res = this.applyMoveInWorld(worldUnits, tm.unitId, tm.toQ, tm.toR, tiles, gameMode);
          const score =
            res.terminalWinner === 'player'
              ? -44000 - quiescenceDepth * 200
              : res.terminalWinner === 'ai'
              ? 44000 + quiescenceDepth * 200
              : this.alphaBetaSearch(
                  res.nextUnits,
                  0,
                  quiescenceDepth - 1,
                  alpha,
                  beta,
                  'ai',
                  tiles,
                  rootAnalysis,
                  gameMode,
                  worldIdx,
                  ply + 1
                );
          if (score < beta) beta = score;
          if (alpha >= beta) break;
        }
        return beta;
      }
    }

    const maxBranch = depth >= 4 ? 12 : depth === 3 ? 10 : 9;
    const moves = this.generateOrderedWorldMoves(
      worldUnits,
      sideToMove,
      tiles,
      false,
      maxBranch,
      ttEntry,
      ply,
      rootAnalysis
    );

    if (moves.length === 0) {
      return sideToMove === 'ai' ? -42000 : 42000;
    }

    let bestMoveUnitId = moves[0].unitId;
    let bestMoveToQ = moves[0].toQ;
    let bestMoveToR = moves[0].toR;

    if (sideToMove === 'ai') {
      let value = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const res = this.applyMoveInWorld(worldUnits, m.unitId, m.toQ, m.toR, tiles, gameMode);
        let childScore: number;
        if (res.terminalWinner === 'ai') {
          childScore = 44000 + depth * 500;
        } else if (res.terminalWinner === 'player') {
          childScore = -44000 - depth * 500;
        } else {
          // Late Move Reduction (LMR) for non-tactical later moves at deeper plies
          const reduction = i >= 3 && depth >= 3 && m.orderScore < 900 ? 2 : 1;
          childScore = this.alphaBetaSearch(
            res.nextUnits,
            depth - reduction,
            quiescenceDepth,
            alpha,
            beta,
            'player',
            tiles,
            rootAnalysis,
            gameMode,
            worldIdx,
            ply + 1
          );
          // Re-search at full depth if reduced search beat alpha
          if (reduction > 1 && childScore > alpha) {
            childScore = this.alphaBetaSearch(
              res.nextUnits,
              depth - 1,
              quiescenceDepth,
              alpha,
              beta,
              'player',
              tiles,
              rootAnalysis,
              gameMode,
              worldIdx,
              ply + 1
            );
          }
        }
        if (childScore > value) {
          value = childScore;
          bestMoveUnitId = m.unitId;
          bestMoveToQ = m.toQ;
          bestMoveToR = m.toR;
        }
        if (value > alpha) alpha = value;
        if (alpha >= beta) {
          const moveKey = `${m.unitId}:${m.toQ},${m.toR}`;
          this.killerMoves.set(ply, moveKey);
          this.historyTable.set(moveKey, (this.historyTable.get(moveKey) ?? 0) + depth * depth);
          break; // Beta cutoff
        }
      }

      const flag: 0 | 1 | 2 = value <= origAlpha ? 2 : value >= origBeta ? 1 : 0;
      this.ttMap.set(stateHash, {
        hash: stateHash,
        depth,
        score: value,
        flag,
        bestUnitId: bestMoveUnitId,
        bestToQ: bestMoveToQ,
        bestToR: bestMoveToR,
        age: this.ttAge
      });
      return value;
    } else {
      let value = Infinity;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const res = this.applyMoveInWorld(worldUnits, m.unitId, m.toQ, m.toR, tiles, gameMode);
        let childScore: number;
        if (res.terminalWinner === 'player') {
          childScore = -44000 - depth * 500;
        } else if (res.terminalWinner === 'ai') {
          childScore = 44000 + depth * 500;
        } else {
          const reduction = i >= 3 && depth >= 3 && m.orderScore < 900 ? 2 : 1;
          childScore = this.alphaBetaSearch(
            res.nextUnits,
            depth - reduction,
            quiescenceDepth,
            alpha,
            beta,
            'ai',
            tiles,
            rootAnalysis,
            gameMode,
            worldIdx,
            ply + 1
          );
          if (reduction > 1 && childScore < beta) {
            childScore = this.alphaBetaSearch(
              res.nextUnits,
              depth - 1,
              quiescenceDepth,
              alpha,
              beta,
              'ai',
              tiles,
              rootAnalysis,
              gameMode,
              worldIdx,
              ply + 1
            );
          }
        }
        if (childScore < value) {
          value = childScore;
          bestMoveUnitId = m.unitId;
          bestMoveToQ = m.toQ;
          bestMoveToR = m.toR;
        }
        if (value < beta) beta = value;
        if (alpha >= beta) {
          const moveKey = `${m.unitId}:${m.toQ},${m.toR}`;
          this.killerMoves.set(ply, moveKey);
          this.historyTable.set(moveKey, (this.historyTable.get(moveKey) ?? 0) + depth * depth);
          break; // Alpha cutoff
        }
      }

      const flag: 0 | 1 | 2 = value <= origAlpha ? 2 : value >= origBeta ? 1 : 0;
      this.ttMap.set(stateHash, {
        hash: stateHash,
        depth,
        score: value,
        flag,
        bestUnitId: bestMoveUnitId,
        bestToQ: bestMoveToQ,
        bestToR: bestMoveToR,
        age: this.ttAge
      });
      return value;
    }
  }

  /**
   * Generates legal moves in a determinized world, ordered by:
   * 1. Transposition Table PV move (+100,000)
   * 2. MVV-LVA (Most Valuable Victim - Least Valuable Attacker), Spy assassinations, Bomb defusals
   * 3. Killer Move Heuristic & History Heuristic
   * 4. Positional & Flag proximity
   */
  private generateOrderedWorldMoves(
    worldUnits: Unit[],
    faction: Faction,
    tiles: Map<string, HexTile>,
    capturesOnly: boolean,
    limit: number,
    ttEntry?: TTEntry,
    ply = 1,
    rootAnalysis?: BoardAnalysis
  ): { unitId: string; toQ: number; toR: number; orderScore: number }[] {
    const unitAtCoord = new Map<string, Unit>();
    let enemyFlag: Unit | null = null;
    let myFlag: Unit | null = null;

    for (const u of worldUnits) {
      unitAtCoord.set(coordKey(u.q, u.r), u);
      if (u.type === 'flag') {
        if (u.faction === faction) myFlag = u;
        else enemyFlag = u;
      }
    }

    const killerKey = this.killerMoves.get(ply);
    const scoredMoves: { unitId: string; toQ: number; toR: number; orderScore: number }[] = [];

    for (const u of worldUnits) {
      if (u.faction !== faction) continue;
      const def = UNIT_DEFINITIONS[u.type];
      if (!def.canMove) continue;

      for (const dir of HEX_DIRECTIONS) {
        for (let step = 1; step <= def.maxMoveRange; step++) {
          const tq = u.q + dir.q * step;
          const tr = u.r + dir.r * step;
          const tile = tiles.get(coordKey(tq, tr));
          if (!tile || tile.terrain === 'water' || tile.terrain === 'mountain') break;

          const isTTBest =
            ttEntry &&
            ttEntry.bestUnitId === u.id &&
            ttEntry.bestToQ === tq &&
            ttEntry.bestToR === tr;
          const moveKey = `${u.id}:${tq},${tr}`;
          const historyBonus = Math.min(400, (this.historyTable.get(moveKey) ?? 0) * 2);
          const killerBonus = killerKey === moveKey ? 900 : 0;

          const occ = unitAtCoord.get(coordKey(tq, tr));
          if (occ) {
            if (occ.faction !== faction) {
              const occDef = UNIT_DEFINITIONS[occ.type];
              let orderScore = (isTTBest ? 100000 : 0) + killerBonus + historyBonus;

              if (occ.revealed) {
                // Target unit identity is public information to both sides
                if (occ.type === 'flag') {
                  orderScore += 20000;
                } else if (occ.type === 'bomb') {
                  if (u.type === 'miner') {
                    orderScore += 2600;
                  } else {
                    break;
                  }
                } else if (u.type === 'spy' && occ.type === 'marshal') {
                  orderScore += 4500;
                } else if (def.rank > occDef.rank) {
                  orderScore += 1600 + occDef.rank * 135 - def.rank * 12;
                  if (myFlag && hexDistance({ q: tq, r: tr }, { q: myFlag.q, r: myFlag.r }) <= 2) {
                    orderScore += 1900;
                  }
                } else if (def.rank === occDef.rank) {
                  orderScore += 550 + occDef.rank * 45;
                } else {
                  break;
                }
                scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
              } else if (faction === 'ai' && rootAnalysis) {
                // Imperfect-Information AI Move Ordering:
                // Use Bayesian `rootAnalysis.beliefMap` rather than peeking at `occ.type` in the determinized world!
                // This prevents Strategy Fusion (where AI delays decisions at the root expecting to peek at cards at ply 3).
                const belief = rootAnalysis.beliefMap.get(occ.id);
                if (belief) {
                  if (u.type === 'miner' && !occ.hasMovedEver) {
                    orderScore += 1500 + belief.pBomb * 1400 + belief.pFlag * 5000;
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  } else if (u.type === 'spy') {
                    if (belief.pByType.marshal >= 0.30) {
                      orderScore += 2200 * belief.pByType.marshal;
                      scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                    }
                  } else {
                    let pWin = belief.pFlag;
                    let pEqual = 0;
                    let pLose = belief.pBomb;
                    for (const t of ORDERED_UNIT_TYPES) {
                      if (t === 'flag' || t === 'bomb') continue;
                      const p = belief.pByType[t];
                      if (p <= 0) continue;
                      const r = UNIT_DEFINITIONS[t].rank;
                      if (def.rank > r) pWin += p;
                      else if (def.rank === r) pEqual += p;
                      else pLose += p;
                    }
                    if (pWin >= 0.42 || (!capturesOnly && def.rank <= 4 && belief.pBomb < 0.35)) {
                      orderScore += pWin * 1650 + pEqual * 450 - pLose * def.rank * 95 + belief.pFlag * 4500;
                      if (myFlag && hexDistance({ q: tq, r: tr }, { q: myFlag.q, r: myFlag.r }) <= 2) {
                        orderScore += 1800;
                      }
                      scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                    }
                  }
                } else {
                  orderScore += 600;
                  scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                }
              } else {
                // Simulated Player attacking an UNREVEALED AI unit (`!occ.revealed`):
                // The human player does NOT know `occ.type`! They only see `occ.hasMovedEver` and `occ.r`.
                if (occ.hasMovedEver) {
                  // Movable unrevealed AI piece: Player officers (rank >= 5) and probers (Scout/Sergeant/Miner) will attack/probe it!
                  if (def.rank >= 5) {
                    orderScore += 1150 + def.rank * 65;
                    if (myFlag && hexDistance({ q: tq, r: tr }, { q: myFlag.q, r: myFlag.r }) <= 2) {
                      orderScore += 1600;
                    }
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  } else if (def.rank >= 2 && (!capturesOnly || step > 1 || def.rank <= 4)) {
                    orderScore += 620 + (step > 1 ? 220 : 0);
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  }
                } else {
                  // Unmoved AI backrow piece (could be Bomb, Flag, or reserve): Player Miners and Scouts/Probers will test it!
                  if (u.type === 'miner') {
                    orderScore += 1650 + (occ.r <= -3 ? 450 : 0);
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  } else if (def.rank <= 4 && u.type !== 'spy') {
                    orderScore += 580 + (occ.r <= -4 ? 320 : 0);
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  } else if (def.rank >= 6 && occ.r >= -2) {
                    orderScore += 680;
                    scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
                  }
                }
              }
            }
            break;
          } else if (!capturesOnly) {
            let orderScore = (isTTBest ? 100000 : 0) + killerBonus + historyBonus;
            const forwardDelta = faction === 'ai' ? tr - u.r : u.r - tr;
            orderScore += forwardDelta * 22;

            if (enemyFlag) {
              const dBefore = hexDistance({ q: u.q, r: u.r }, { q: enemyFlag.q, r: enemyFlag.r });
              const dAfter = hexDistance({ q: tq, r: tr }, { q: enemyFlag.q, r: enemyFlag.r });
              orderScore += (dBefore - dAfter) * (u.type === 'miner' || def.rank >= 6 ? 48 : 25);
            }

            for (const n of getNeighbors(tq, tr)) {
              const adj = unitAtCoord.get(coordKey(n.q, n.r));
              if (adj && adj.faction !== faction) {
                const adjDef = UNIT_DEFINITIONS[adj.type];
                if (adj.type === 'flag') {
                  orderScore += 950;
                } else if (adj.type === 'bomb' && u.type === 'miner') {
                  orderScore += 420;
                } else if (u.type === 'spy' && adj.type === 'marshal') {
                  orderScore += 620;
                } else if (adj.type !== 'bomb' && def.rank > adjDef.rank) {
                  orderScore += 160 + adjDef.rank * 20;
                } else if (adj.type !== 'bomb' && adjDef.rank > def.rank) {
                  orderScore -= def.rank * 55;
                }
              }
            }

            scoredMoves.push({ unitId: u.id, toQ: tq, toR: tr, orderScore });
          }
        }
      }
    }

    scoredMoves.sort((a, b) => b.orderScore - a.orderScore);
    return scoredMoves.slice(0, limit);
  }

  /**
   * Applies a move on a simulated world state and returns the resulting board state + any terminal winner.
   */
  private applyMoveInWorld(
    worldUnits: Unit[],
    moverId: string,
    toQ: number,
    toR: number,
    tiles: Map<string, HexTile>,
    gameMode: GameMode
  ): { nextUnits: Unit[]; terminalWinner: Faction | null } {
    let mover: Unit | undefined;
    let defender: Unit | undefined;

    for (const u of worldUnits) {
      if (u.id === moverId) mover = u;
      else if (u.q === toQ && u.r === toR) defender = u;
    }

    if (!mover) {
      return { nextUnits: worldUnits, terminalWinner: null };
    }

    const dist = hexDistance({ q: mover.q, r: mover.r }, { q: toQ, r: toR });
    const nextUnits: Unit[] = [];

    if (!defender) {
      for (const u of worldUnits) {
        if (u.id === mover.id) {
          let nextType = u.type;
          let nextXp = u.xp ?? 0;
          if (gameMode === 'scouts_only') {
            const tile = tiles.get(coordKey(toQ, toR));
            const isForward = u.faction === 'player' ? toR < u.r : toR > u.r;
            if (isForward || tile?.terrain === 'forest') {
              nextXp++;
              if (nextXp >= 2) {
                const idx = PROMOTION_CHAIN.indexOf(nextType);
                if (idx !== -1 && idx < PROMOTION_CHAIN.length - 1) {
                  nextType = PROMOTION_CHAIN[idx + 1];
                  nextXp = 0;
                }
              }
            }
          }
          nextUnits.push({
            ...u,
            type: nextType,
            q: toQ,
            r: toR,
            hasMovedEver: true,
            revealed: u.revealed || dist > 1,
            xp: nextXp
          });
        } else {
          nextUnits.push(u);
        }
      }
      return { nextUnits, terminalWinner: null };
    }

    // Combat resolution in world
    if (defender.type === 'flag') {
      return { nextUnits: worldUnits, terminalWinner: mover.faction };
    }

    const attRank = UNIT_DEFINITIONS[mover.type].rank;
    const defRank = UNIT_DEFINITIONS[defender.type].rank;

    let winner: 'attacker' | 'defender' | 'both_die';
    if (defender.type === 'bomb') {
      winner = mover.type === 'miner' ? 'attacker' : 'defender';
    } else if (mover.type === 'spy' && defender.type === 'marshal') {
      winner = 'attacker';
    } else if (attRank > defRank) {
      winner = 'attacker';
    } else if (attRank < defRank) {
      winner = 'defender';
    } else {
      winner = 'both_die';
    }

    for (const u of worldUnits) {
      if (u.id === mover.id) {
        if (winner === 'attacker') {
          let nextType = u.type;
          if (gameMode === 'scouts_only') {
            const idx = PROMOTION_CHAIN.indexOf(nextType);
            if (idx !== -1 && idx < PROMOTION_CHAIN.length - 1) {
              nextType = PROMOTION_CHAIN[idx + 1];
            }
          }
          nextUnits.push({
            ...u,
            type: nextType,
            q: toQ,
            r: toR,
            hasMovedEver: true,
            revealed: true,
            xp: 0
          });
        }
      } else if (u.id === defender.id) {
        if (winner === 'defender') {
          let nextType = u.type;
          if (gameMode === 'scouts_only' && u.type !== 'bomb' && u.type !== 'flag') {
            const idx = PROMOTION_CHAIN.indexOf(nextType);
            if (idx !== -1 && idx < PROMOTION_CHAIN.length - 1) {
              nextType = PROMOTION_CHAIN[idx + 1];
            }
          }
          nextUnits.push({
            ...u,
            type: nextType,
            revealed: true,
            xp: 0
          });
        }
      } else {
        nextUnits.push(u);
      }
    }

    return { nextUnits, terminalWinner: null };
  }

  /**
   * Game-Theoretic Static Evaluation of a simulated world state (from AI's perspective).
   */
  private evaluateWorldState(
    worldUnits: Unit[],
    sideToMove: Faction,
    rootAnalysis: BoardAnalysis
  ): number {
    let score = 0;

    let aiFlag: Unit | null = null;
    let playerFlag: Unit | null = null;
    let aiMarshalUnit: Unit | null = null;
    let aiGeneralUnit: Unit | null = null;
    let aiSpyUnit: Unit | null = null;
    let playerMarshalUnit: Unit | null = null;
    let playerSpyUnit: Unit | null = null;
    let aiMaxRank = 0;
    let playerMaxRank = 0;
    let aiMiners = 0;
    let playerMiners = 0;
    let aiBombs = 0;
    let playerBombs = 0;
    let aiMovableCount = 0;
    let playerMovableCount = 0;

    const unitAtCoord = new Map<string, Unit>();

    for (const u of worldUnits) {
      unitAtCoord.set(coordKey(u.q, u.r), u);
      const def = UNIT_DEFINITIONS[u.type];
      if (u.faction === 'ai') {
        if (u.type === 'flag') aiFlag = u;
        else if (u.type === 'bomb') aiBombs++;
        else {
          aiMovableCount++;
          if (def.rank > aiMaxRank) aiMaxRank = def.rank;
          if (u.type === 'miner') aiMiners++;
          else if (u.type === 'marshal') aiMarshalUnit = u;
          else if (u.type === 'general') aiGeneralUnit = u;
          else if (u.type === 'spy') aiSpyUnit = u;
        }
      } else {
        if (u.type === 'flag') playerFlag = u;
        else if (u.type === 'bomb') playerBombs++;
        else {
          playerMovableCount++;
          if (def.rank > playerMaxRank) playerMaxRank = def.rank;
          if (u.type === 'miner') playerMiners++;
          else if (u.type === 'marshal') playerMarshalUnit = u;
          else if (u.type === 'spy') playerSpyUnit = u;
        }
      }
    }

    if (!aiFlag || aiMovableCount === 0) return -43000;
    if (!playerFlag || playerMovableCount === 0) return 43000;

    let maxAiHangingVal = 0;
    let maxPlayerHangingVal = 0;

    // 1. Material + Information Asymmetry + Positional Pressure + Immediate Clash Tempo
    for (const u of worldUnits) {
      if (u.type === 'flag') continue;
      const val = this.getUnitValue(u.type, u.faction, rootAnalysis);
      const def = UNIT_DEFINITIONS[u.type];

      if (u.faction === 'ai') {
        score += val;
        // Fog-of-War Information Hiding Premium: keeping AI high-value pieces unrevealed is a major advantage!
        if (!u.revealed && (def.rank >= 7 || u.type === 'spy' || u.type === 'miner')) {
          score += def.rank >= 9 ? 90 : 52;
        }
        // Pressure toward Player Flag
        if (def.canMove && u.type !== 'spy') {
          const distToEnemyFlag = hexDistance({ q: u.q, r: u.r }, { q: playerFlag.q, r: playerFlag.r });
          if (u.type === 'miner') {
            score += Math.max(0, 9 - distToEnemyFlag) * 26;
          } else if (def.rank >= 6) {
            score += Math.max(0, 9 - distToEnemyFlag) * 18;
          } else {
            score += Math.max(0, 8 - distToEnemyFlag) * 8;
          }
        }

        // Check adjacent enemy clashes for tempo-aware en-prise evaluation
        if (def.canMove) {
          for (const n of getNeighbors(u.q, u.r)) {
            const adj = unitAtCoord.get(coordKey(n.q, n.r));
            if (!adj || adj.faction === 'ai') continue;
            const adjDef = UNIT_DEFINITIONS[adj.type];
            const adjVal = this.getUnitValue(adj.type, 'player', rootAnalysis);

            if (adj.type === 'flag') {
              maxPlayerHangingVal = Math.max(maxPlayerHangingVal, 6000);
            } else if (adj.type === 'bomb') {
              if (u.type === 'miner') {
                maxPlayerHangingVal = Math.max(maxPlayerHangingVal, 420);
              }
            } else {
              // Both are movable units adjacent to each other
              const aiWinsOnAiTurn = (u.type === 'spy' && adj.type === 'marshal') || def.rank > adjDef.rank;
              const playerWinsOnPlayerTurn =
                (adj.type === 'spy' && u.type === 'marshal') || adjDef.rank > def.rank;

              if (aiWinsOnAiTurn && (adj.revealed || def.rank >= 7)) {
                maxPlayerHangingVal = Math.max(maxPlayerHangingVal, adjVal);
              }
              if (playerWinsOnPlayerTurn && (u.revealed || adjDef.rank >= 7 || adj.type === 'spy')) {
                maxAiHangingVal = Math.max(maxAiHangingVal, val);
              }
            }
          }
        }
      } else {
        score -= val;
        // Revealed enemy units reduce AI's uncertainty (Information Gain bonus)
        if (u.revealed && u.type !== 'bomb') {
          score += def.rank >= 7 || u.type === 'spy' || u.type === 'miner' ? 68 : 30;
        }
        // Enemy threat to AI Flag
        if (def.canMove && u.type !== 'spy') {
          const distToAiFlag = hexDistance({ q: u.q, r: u.r }, { q: aiFlag.q, r: aiFlag.r });
          if (distToAiFlag === 1) {
            score -= sideToMove === 'player' ? 3200 : 950;
          } else if (distToAiFlag === 2) {
            score -= 360;
          } else if (distToAiFlag === 3) {
            score -= 120;
          }
        }
      }
    }

    // Apply Tempo-Aware Hanging Piece Adjustment at leaf nodes!
    if (sideToMove === 'player') {
      score -= maxAiHangingVal * 0.74;
      score += maxPlayerHangingVal * 0.20;
    } else {
      score += maxPlayerHangingVal * 0.74;
      score -= maxAiHangingVal * 0.20;
    }

    // 2. Apex Rank Dominance & Marshal-General-Spy Triangle
    if (aiMaxRank > playerMaxRank) {
      score += 340;
    } else if (playerMaxRank > aiMaxRank) {
      score -= 340;
    }

    if (aiSpyUnit && playerMarshalUnit) {
      const spyToMarshalDist = hexDistance(
        { q: aiSpyUnit.q, r: aiSpyUnit.r },
        { q: playerMarshalUnit.q, r: playerMarshalUnit.r }
      );
      if (playerMarshalUnit.revealed) {
        score += Math.max(0, 7 - spyToMarshalDist) * 32;
      }
      if (aiGeneralUnit) {
        const spyToGenDist = hexDistance(
          { q: aiSpyUnit.q, r: aiSpyUnit.r },
          { q: aiGeneralUnit.q, r: aiGeneralUnit.r }
        );
        if (spyToGenDist <= 2) {
          score += 55;
        }
      }
    }

    if (aiMarshalUnit && aiMarshalUnit.revealed && playerSpyUnit) {
      const hasFriendlyScreen = worldUnits.some(
        u =>
          u.faction === 'ai' &&
          u.id !== aiMarshalUnit!.id &&
          UNIT_DEFINITIONS[u.type].canMove &&
          hexDistance({ q: u.q, r: u.r }, { q: aiMarshalUnit!.q, r: aiMarshalUnit!.r }) <= 2
      );
      if (!hasFriendlyScreen) {
        score -= 90;
      }
    }

    // 3. Endgame Bomb-Lock / Miner Extinction Asymmetry
    if (playerBombs > 0 && aiMiners === 0) {
      score -= 720;
    }
    if (aiBombs > 0 && playerMiners === 0) {
      score += 660;
    }

    return score;
  }

  private evaluateMove(
    aiUnit: Unit,
    toQ: number,
    toR: number,
    units: Unit[],
    tiles: Map<string, HexTile>,
    turn: number,
    difficulty: AIDifficulty,
    analysis: BoardAnalysis,
    currentUnitDanger: Map<string, number>,
    startDists: Map<string, number>,
    gameMode: GameMode = 'classic'
  ): number {
    let score = 0;
    const isUltra = difficulty === 'ultra';
    const myDef = UNIT_DEFINITIONS[aiUnit.type];
    const myVal = this.getUnitValue(aiUnit.type, 'ai', analysis);
    const moveDist = hexDistance({ q: aiUnit.q, r: aiUnit.r }, { q: toQ, r: toR });
    const targetUnit = units.find(u => u.q === toQ && u.r === toR);

    const willBeRevealed = aiUnit.revealed || moveDist > 1 || Boolean(targetUnit);

    const simulatedBoard: Unit[] = [];
    for (const u of units) {
      if (u.id === aiUnit.id) {
        simulatedBoard.push({ ...u, q: toQ, r: toR, revealed: willBeRevealed, hasMovedEver: true });
      } else if (targetUnit && u.id === targetUnit.id) {
        continue;
      } else {
        simulatedBoard.push(u);
      }
    }

    const myDangerBefore = currentUnitDanger.get(aiUnit.id) || 0;
    const myDangerAfter = this.evaluateCounterAttackRisk(
      aiUnit,
      toQ,
      toR,
      willBeRevealed,
      tiles,
      simulatedBoard,
      analysis
    );

    // 1. Evaluate rescuing `aiUnit` from immediate danger
    if (myDangerBefore > 80) {
      score += (myDangerBefore - myDangerAfter) * 0.95;
    }

    // 2. If `targetUnit` was threatening ANY other friendly unit, killing `targetUnit` rescues that friendly unit!
    if (targetUnit && targetUnit.faction === 'player') {
      for (const friendly of units) {
        if (friendly.faction !== 'ai' || friendly.id === aiUnit.id) continue;
        const dangerBefore = currentUnitDanger.get(friendly.id) || 0;
        if (dangerBefore > 120) {
          const dangerAfter = this.evaluateCounterAttackRisk(
            friendly,
            friendly.q,
            friendly.r,
            friendly.revealed,
            tiles,
            simulatedBoard,
            analysis
          );
          if (dangerAfter < dangerBefore) {
            score += (dangerBefore - dangerAfter) * 0.85;
          }
        }
      }
    }

    // 3. Flag Guard / Kingpin Goalie Integrity:
    if (analysis.aiFlag) {
      const distToMyFlagBefore = hexDistance(
        { q: aiUnit.q, r: aiUnit.r },
        { q: analysis.aiFlag.q, r: analysis.aiFlag.r }
      );
      const distToMyFlagAfter = hexDistance(
        { q: toQ, r: toR },
        { q: analysis.aiFlag.q, r: analysis.aiFlag.r }
      );
      const otherMovableAI = units.filter(
        u => u.faction === 'ai' && u.id !== aiUnit.id && UNIT_DEFINITIONS[u.type].canMove
      );

      if (distToMyFlagBefore === 1 && distToMyFlagAfter > 1 && !targetUnit && otherMovableAI.length >= 2) {
        score -= 520;
      }

      if (distToMyFlagBefore > 1 && distToMyFlagAfter === 1 && !targetUnit && myDef.rank >= 4) {
        score += 260;
      }
    }

    const targetDistToAiFlag =
      targetUnit && analysis.aiFlag
        ? hexDistance({ q: targetUnit.q, r: targetUnit.r }, { q: analysis.aiFlag.q, r: analysis.aiFlag.r })
        : 99;

    // ========================================================================
    // BRANCH A: ATTACKING AN ENEMY UNIT
    // ========================================================================
    if (targetUnit && targetUnit.faction === 'player') {
      if (targetUnit.revealed) {
        const targetDef = UNIT_DEFINITIONS[targetUnit.type];
        const targetVal = this.getUnitValue(targetUnit.type, 'player', analysis);

        if (targetUnit.type === 'flag') {
          return 50000;
        }

        if (targetUnit.type === 'bomb') {
          if (aiUnit.type === 'miner') {
            let bombScore = 680 - myDangerAfter * 0.75;
            if (targetUnit.r >= 3) bombScore += 240;
            // Extra bonus if this Bomb is adjacent to the most likely Player Flag!
            if (
              analysis.mostLikelyFlagUnit &&
              hexDistance(
                { q: targetUnit.q, r: targetUnit.r },
                { q: analysis.mostLikelyFlagUnit.q, r: analysis.mostLikelyFlagUnit.r }
              ) === 1
            ) {
              bombScore += 450;
            }
            return bombScore;
          } else {
            return -20000;
          }
        }

        if (aiUnit.type === 'spy' && targetUnit.type === 'marshal') {
          return 1850 - myDangerAfter * 0.45;
        }

        if (myDef.rank > targetDef.rank) {
          score += 210 + targetVal - myDangerAfter * 0.95;

          // Least Valuable Attacker (LVA) & Information Hiding:
          // Avoid revealing our Marshal (10) or General (9) on a lower-rank enemy when another friendly officer can handle it!
          if (!aiUnit.revealed && myDef.rank >= 9 && targetDef.rank <= 6 && targetDistToAiFlag > 2) {
            const lowerAllyCanHandle = units.some(
              u =>
                u.faction === 'ai' &&
                u.id !== aiUnit.id &&
                UNIT_DEFINITIONS[u.type].canMove &&
                UNIT_DEFINITIONS[u.type].rank > targetDef.rank &&
                UNIT_DEFINITIONS[u.type].rank < myDef.rank &&
                hexDistance({ q: u.q, r: u.r }, { q: targetUnit.q, r: targetUnit.r }) <= 2
            );
            if (lowerAllyCanHandle) {
              score -= isUltra ? 265 : 185;
            } else if (targetDef.rank <= 3 && targetUnit.r > -1) {
              score -= isUltra ? 210 : 155;
            }
          }
          // Reward exact counter-rank kills (e.g. Major 7 killing Captain 6, Colonel 8 killing Major 7)
          if (myDef.rank === targetDef.rank + 1 || myDef.rank === targetDef.rank + 2) {
            score += 65;
          }

          if (targetDistToAiFlag === 1) {
            score += 2800;
          } else if (targetDistToAiFlag === 2) {
            score += 980;
          } else if (targetDistToAiFlag === 3) {
            score += 440;
          } else if (targetUnit.r <= -1) {
            score += 165 + Math.abs(targetUnit.r) * 55;
          }
        } else if (myDef.rank === targetDef.rank) {
          let tradeScore = targetVal - myVal + 35;

          if (gameMode === 'scouts_only' && aiUnit.type === 'scout' && analysis.aiMinersAlive === 0) {
            tradeScore -= 160;
          }

          if (aiUnit.type === 'marshal') {
            if (analysis.aiGeneralAlive && !analysis.playerGeneralAlive) {
              tradeScore += 420; // Trading Marshals makes our General the undisputed king of the board!
            } else if (analysis.aiSpyAlive) {
              tradeScore -= 280;
            }
          }

          if (aiUnit.type === 'miner' && analysis.aiMinersAlive <= 1 && analysis.unrevealedBombs > 0) {
            tradeScore -= 600;
          }

          if (targetDistToAiFlag <= 2) {
            tradeScore += 1200;
          } else if (targetUnit.r <= -1) {
            tradeScore += 140;
          }

          score += tradeScore;
        } else {
          return -15000 - myVal;
        }
      } else {
        // --- UNKNOWN (UNREVEALED) PLAYER UNIT ---
        const belief = this.getUnitBelief(targetUnit, analysis, units);

        let ev = 0;

        // 1. Flag outcome
        ev += belief.pFlag * 5200;

        // 2. Bomb outcome
        if (aiUnit.type === 'miner') {
          ev += belief.pBomb * 820;
        } else {
          ev -= belief.pBomb * (myVal * 1.28 + 135);
        }

        // 3. Movable unit outcomes + Shannon Information Gain (VoI)
        const shannonInfoBonus = isUltra ? belief.entropy * 34 : 0;

        for (const t of ORDERED_UNIT_TYPES) {
          if (t === 'flag' || t === 'bomb') continue;
          const p = belief.pByType[t];
          if (p <= 0) continue;

          const enemyDef = UNIT_DEFINITIONS[t];
          const enemyVal = this.getUnitValue(t, 'player', analysis);

          const spyWins = aiUnit.type === 'spy' && t === 'marshal';
          if (spyWins || myDef.rank > enemyDef.rank) {
            ev += p * (enemyVal + 110 + shannonInfoBonus * 0.4 - myDangerAfter * 0.9);
          } else if (myDef.rank === enemyDef.rank) {
            const tradePenalty =
              gameMode === 'scouts_only' && aiUnit.type === 'scout' && analysis.aiMinersAlive === 0
                ? -140
                : 25;
            ev += p * (enemyVal - myVal + tradePenalty + shannonInfoBonus * 0.3);
          } else {
            let infoValue = 0;
            if (aiUnit.type === 'scout') {
              infoValue = (moveDist > 1 ? 290 : 235) + shannonInfoBonus;
            } else if (aiUnit.type === 'sergeant') {
              infoValue = 185 + shannonInfoBonus * 0.85;
            } else if (aiUnit.type === 'lieutenant') {
              infoValue = 140 + shannonInfoBonus * 0.7;
            } else if (aiUnit.type === 'captain') {
              infoValue = 85 + shannonInfoBonus * 0.4;
            }
            ev += p * (infoValue - myVal * 0.92);
          }
        }

        score += ev;

        // Game-Theoretic Information Signaling Cost:
        // If an unrevealed Marshal or General attacks an unknown unit that might be a Bomb or low-rank bait,
        // penalize giving away the identity & location of our top piece!
        if (isUltra && !aiUnit.revealed && myDef.rank >= 9 && belief.pFlag < 0.15) {
          score -= 115;
        }

        if (aiUnit.type === 'scout') {
          if (moveDist > 1) {
            score += 175;
          }
          if (targetUnit.hasMovedEver) {
            score += 145 + (targetUnit.r <= 1 ? 65 : 0);
          }
        } else if (aiUnit.type === 'miner') {
          if (targetUnit.hasMovedEver && analysis.unrevealedBombs > 0 && analysis.aiMinersAlive <= 2) {
            score -= 240;
          }
          if (!targetUnit.hasMovedEver && targetUnit.r >= 3) {
            score += 270;
          }
        } else if (aiUnit.type === 'spy') {
          if (belief.pByType.marshal < 0.45) {
            score -= 550;
          }
        } else if (myDef.rank >= 7) {
          if (targetUnit.hasMovedEver && myDef.rank >= analysis.highestUnrevealedPlayerRank) {
            score += 210;
          }
        }

        if (targetDistToAiFlag === 1 && aiUnit.type !== 'spy') {
          score += 2250;
        } else if (targetDistToAiFlag === 2 && aiUnit.type !== 'spy') {
          score += 780;
        } else if (targetDistToAiFlag === 3 && aiUnit.type !== 'spy') {
          score += 360;
        } else if (targetUnit.r <= -1 && aiUnit.type !== 'spy') {
          score += 125 + Math.abs(targetUnit.r) * 45;
        }
      }
    } else {
      // ======================================================================
      // BRANCH B: POSITIONAL MOVEMENT ONTO AN EMPTY HEX
      // ======================================================================
      score -= myDangerAfter * 0.98;

      // Never reveal a Scout by multi-stepping onto an empty square unless escaping grave danger
      if (aiUnit.type === 'scout' && moveDist > 1 && !aiUnit.revealed && myDangerBefore < 80) {
        score -= 240;
      }

      // Opening/Midgame Concealment for Unrevealed Marshal (10) & General (9):
      // Keep top apex officers coiled in the 2nd line (r <= -1) while Scouts & mid-officers probe unknown enemy formations!
      if (
        !aiUnit.revealed &&
        myDef.rank >= 9 &&
        analysis.totalHiddenMovable >= 10 &&
        toR >= 0 &&
        myDangerBefore < 80
      ) {
        score -= isUltra ? 135 : 90;
      }

      const afterDists = this.computeDistanceMapFrom(toQ, toR, aiUnit, tiles, simulatedBoard);

      let bestMissionBonus = -999;
      const playerUnits = units.filter(u => u.faction === 'player');
      const aiFlag = analysis.aiFlag;

      for (const pu of playerUnits) {
        const puKey = coordKey(pu.q, pu.r);
        const distBefore = startDists.get(puKey) ?? 22;
        const distAfter = afterDists.get(puKey) ?? 22;
        const progress = distBefore - distAfter;

        let targetPriority = 0;

        if (pu.revealed) {
          const puDef = UNIT_DEFINITIONS[pu.type];
          if (pu.type === 'flag') {
            targetPriority = 380;
          } else if (pu.type === 'bomb') {
            if (aiUnit.type === 'miner') {
              targetPriority = pu.r >= 3 ? 210 : 135;
              if (
                analysis.mostLikelyFlagUnit &&
                hexDistance(
                  { q: pu.q, r: pu.r },
                  { q: analysis.mostLikelyFlagUnit.q, r: analysis.mostLikelyFlagUnit.r }
                ) === 1
              ) {
                targetPriority += 95;
              }
            } else {
              targetPriority = -25;
            }
          } else if (pu.type === 'marshal') {
            if (aiUnit.type === 'spy') {
              targetPriority = 285;
            } else if (
              (aiUnit.type === 'general' || aiUnit.type === 'colonel') &&
              analysis.aiSpyAlive
            ) {
              // Escort the Spy and pin the revealed Player Marshal!
              targetPriority = 165;
            } else if (
              aiUnit.type === 'marshal' &&
              ((analysis.aiGeneralAlive && !analysis.playerGeneralAlive) || pu.r <= -1)
            ) {
              targetPriority = 230;
            } else {
              targetPriority = -35;
            }
          } else if (myDef.rank > puDef.rank) {
            targetPriority = 65 + puDef.rank * 11.5;
            if (puDef.rank >= 6) targetPriority += 48;
            // Prefer sending the ideal counter-rank (+1 or +2 above target, or already revealed) to hunt revealed enemy officers!
            if (
              myDef.rank === puDef.rank + 1 ||
              myDef.rank === puDef.rank + 2 ||
              aiUnit.revealed
            ) {
              targetPriority += 55;
            } else if (!aiUnit.revealed && myDef.rank >= 9 && puDef.rank <= 4) {
              targetPriority -= 45;
            }
          } else if (myDef.rank < puDef.rank) {
            targetPriority = -35;
          }
        } else {
          const belief = this.getUnitBelief(pu, analysis, units);
          const isUnmovedBackrow = !pu.hasMovedEver && pu.r >= 3;

          if (aiUnit.type === 'miner') {
            if (isUnmovedBackrow) {
              const totalPlayerLeft = playerUnits.length;
              targetPriority = (totalPlayerLeft <= 17 ? 145 : 75) + belief.pBomb * 85 + belief.pFlag * 130;
            } else if (!pu.hasMovedEver && pu.r === 2) {
              targetPriority = 75 + belief.pBomb * 55;
            } else {
              targetPriority = 8;
            }
          } else if (aiUnit.type === 'spy') {
            targetPriority = belief.pByType.marshal > 0.30 ? belief.pByType.marshal * 185 : -10;
          } else if (aiUnit.type === 'scout') {
            targetPriority = (isUnmovedBackrow ? 35 : 82) + (isUltra ? belief.entropy * 9 : 0);
          } else if (aiUnit.type === 'sergeant' || aiUnit.type === 'lieutenant') {
            targetPriority = isUnmovedBackrow ? (analysis.aiMinersAlive > 0 ? 24 : 52) : 72;
          } else if (myDef.rank >= 6) {
            if (pu.hasMovedEver) {
              targetPriority = 64;
              if (myDef.rank >= analysis.highestUnrevealedPlayerRank) {
                targetPriority += 45;
              }
            } else {
              targetPriority = analysis.unrevealedBombs === 0 ? 135 : 18 + belief.pFlag * 150;
            }
          }
        }

        if (pu.r <= 0 && aiUnit.type !== 'spy') {
          const canBeatIntruder =
            !pu.revealed ||
            (pu.type !== 'bomb' && myDef.rank >= UNIT_DEFINITIONS[pu.type].rank);
          if (canBeatIntruder && myDef.rank >= 4) {
            let defenseUrgency = pu.r <= -1 ? 80 + Math.abs(pu.r) * 38 : 0;
            if (aiFlag) {
              const flagDist = hexDistance({ q: pu.q, r: pu.r }, { q: aiFlag.q, r: aiFlag.r });
              if (flagDist === 1) defenseUrgency = 520;
              else if (flagDist === 2) defenseUrgency = Math.max(defenseUrgency, 280);
              else if (flagDist === 3) defenseUrgency = Math.max(defenseUrgency, 155);
            }
            targetPriority = Math.max(targetPriority, defenseUrgency);
          }
        }

        if (targetPriority > 0) {
          const missionScore =
            progress * targetPriority + Math.max(0, 14 - distAfter) * (targetPriority * 0.2);
          if (missionScore > bestMissionBonus) {
            bestMissionBonus = missionScore;
          }
        }
      }

      if (bestMissionBonus > -900) {
        score += bestMissionBonus;
      }

      // ======================================================================
      // ULTRA GAME-THEORETIC FORMATION SYNERGIES & CHOKEPOINT DOMINANCE
      // ======================================================================
      if (isUltra) {
        // 1. Chokepoint & Bridge Control: reward strong officers holding the 4 central bridges
        if (myDef.rank >= 6 && myDangerAfter < 100) {
          const isChokepoint = CENTRAL_CHOKEPOINTS.some(cp => cp.q === toQ && cp.r === toR);
          if (isChokepoint) {
            score += 42;
          }
        }

        // 2. Protected Miner Convoy: reward high-rank officers escorting a Miner advancing into enemy territory,
        // and reward Miners staying within 1-2 hexes of a friendly Colonel/General/Marshal!
        if (aiUnit.type === 'miner' && toR >= 0) {
          const hasOfficerEscort = units.some(
            u =>
              u.faction === 'ai' &&
              UNIT_DEFINITIONS[u.type].rank >= 7 &&
              hexDistance({ q: toQ, r: toR }, { q: u.q, r: u.r }) <= 2
          );
          if (hasOfficerEscort) {
            score += 55;
          }
        } else if (myDef.rank >= 7) {
          const escortsAdvancingMiner = units.some(
            u =>
              u.faction === 'ai' &&
              u.type === 'miner' &&
              u.r >= -1 &&
              hexDistance({ q: toQ, r: toR }, { q: u.q, r: u.r }) === 1
          );
          if (escortsAdvancingMiner) {
            score += 48;
          }
        }

        // 3. Crossfire / Mutual Support Triangle:
        // Reward stepping onto a square where if an enemy attacks a nearby friendly unit, `aiUnit` is immediately adjacent to avenge it!
        if (myDef.rank >= 7) {
          let avengedAllies = 0;
          for (const ally of units) {
            if (ally.faction !== 'ai' || ally.id === aiUnit.id) continue;
            if (ally.r >= -1 && hexDistance({ q: toQ, r: toR }, { q: ally.q, r: ally.r }) === 1) {
              avengedAllies++;
            }
          }
          score += Math.min(2, avengedAllies) * 24;
        }
      }

      // Special Role: AI Spy positioning & Marshal Ambush Trap!
      if (aiUnit.type === 'spy' && analysis.playerMarshalAlive) {
        if (analysis.playerMarshalRevealed) {
          const pm = analysis.playerMarshalRevealed;
          const hexDistAfter = hexDistance({ q: toQ, r: toR }, { q: pm.q, r: pm.r });
          if (hexDistAfter === 2) {
            score += 115;
            const guardsBait = units.some(
              u =>
                u.faction === 'ai' &&
                u.id !== aiUnit.id &&
                hexDistance({ q: toQ, r: toR }, { q: u.q, r: u.r }) === 1 &&
                hexDistance({ q: u.q, r: u.r }, { q: pm.q, r: pm.r }) === 1
            );
            if (guardsBait) {
              score += 165;
            }
          }
        } else {
          const escort =
            units.find(u => u.faction === 'ai' && u.type === 'general') ||
            units.find(u => u.faction === 'ai' && u.type === 'colonel');
          if (escort) {
            const dBefore = hexDistance({ q: aiUnit.q, r: aiUnit.r }, { q: escort.q, r: escort.r });
            const dAfter = hexDistance({ q: toQ, r: toR }, { q: escort.q, r: escort.r });
            const idealBefore = Math.abs(dBefore - 1.3);
            const idealAfter = Math.abs(dAfter - 1.3);
            score += (idealBefore - idealAfter) * 62;
            if (toR <= escort.r) score += 22;
          }
        }
      }

      // Lane-Clearing / Escort Hand-Off for Miners:
      if (aiUnit.type !== 'miner') {
        const blockingBombForMiner = units.some(
          pu =>
            pu.faction === 'player' &&
            ((pu.revealed && pu.type === 'bomb') ||
              (!pu.hasMovedEver && pu.r >= 3 && analysis.unrevealedBombs > 0)) &&
            hexDistance({ q: aiUnit.q, r: aiUnit.r }, { q: pu.q, r: pu.r }) === 1 &&
            hexDistance({ q: toQ, r: toR }, { q: pu.q, r: pu.r }) >= 1 &&
            units.some(
              m =>
                m.faction === 'ai' &&
                m.type === 'miner' &&
                hexDistance({ q: m.q, r: m.r }, { q: aiUnit.q, r: aiUnit.r }) <= 2
            )
        );
        if (blockingBombForMiner) {
          score += 165;
        }
      }

      if (
        aiUnit.type === 'miner' &&
        turn <= 10 &&
        analysis.unrevealedBombs > 0 &&
        analysis.aiMinersAlive <= 2
      ) {
        const hasRevealedBombTarget = playerUnits.some(pu => pu.revealed && pu.type === 'bomb');
        if (!hasRevealedBombTarget && toR >= -1) {
          score -= 70;
        }
      }

      if (aiUnit.type !== 'spy' && !(aiUnit.type === 'miner' && turn <= 8)) {
        score += (toR - aiUnit.r) * 14;
      }

      // In 'scouts_only' mode, reward forward reconnaissance and forest outpost control to level up!
      if (gameMode === 'scouts_only' && PROMOTION_CHAIN.includes(aiUnit.type) && aiUnit.type !== 'marshal') {
        const destTile = tiles.get(coordKey(toQ, toR));
        let canGainXp = false;
        if (toR > aiUnit.r) {
          canGainXp = true;
          score += 55 + (toR >= 1 ? 45 : 0);
        }
        if (destTile && destTile.terrain === 'forest') {
          canGainXp = true;
          score += 95;
        }
        if (canGainXp && (aiUnit.xp ?? 0) >= 1) {
          score += 185;
        }
      }
    }

    // ========================================================================
    // ANTI-OSCILLATION & MOVE HISTORY PENALTIES
    // ========================================================================
    for (let i = 0; i < this.moveHistory.length; i++) {
      const rec = this.moveHistory[i];
      if (rec.unitId === aiUnit.id) {
        if (rec.toQ === aiUnit.q && rec.toR === aiUnit.r && rec.fromQ === toQ && rec.fromR === toR) {
          if (myDangerBefore < 120) {
            score -= 185;
          }
        }
        if (i < 6 && rec.fromQ === toQ && rec.fromR === toR && myDangerBefore < 120) {
          score -= 75;
        }
      }
    }

    const jitter = difficulty === 'ultra' ? 0.8 : difficulty === 'hard' ? 3 : 20;
    if (this.workerSessionSeed !== null) {
      let h = (this.workerSessionSeed ^ (toQ * 73856093) ^ (toR * 19349663)) >>> 0;
      for (let i = 0; i < aiUnit.id.length; i++) {
        h = Math.imul(h ^ aiUnit.id.charCodeAt(i), 16777619) >>> 0;
      }
      const norm = (h & 0xffff) / 0xffff;
      score += (norm - 0.5) * jitter;
    } else {
      score += (Math.random() - 0.5) * jitter;
    }

    return score;
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
