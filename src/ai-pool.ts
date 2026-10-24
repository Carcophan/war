import {
  AISearchStats,
  PonderReplyEntry,
  StrategoAIEngine,
  WorkerRootCandidate
} from './ai';
import type { WorkerInMessage, WorkerOutMessage } from './ai.worker';
import { AxialCoord } from './hex';
import { AIDifficulty, Faction, GameMode, HexTile, UNIT_DEFINITIONS, Unit } from './types';

interface WorkerSlot {
  index: number;
  worker: Worker;
  busy: boolean;
  readySessionId: number;
  ttSize: number;
  ttHits: number;
  totalNodes: number;
}

interface PendingTask {
  taskId: number;
  candIdx: number;
  worldIdx: number;
  candMove: WorkerRootCandidate;
}

interface DepthCandidateAccumulator {
  expectedScore: number;
  worstScore: number;
  completedWorlds: number;
  aiPvLine?: string;
}

interface PoolSession {
  sessionId: number;
  boardSignature: string;
  units: Unit[];
  sideToMove: Faction;
  phase: 'setup_analysis' | 'pondering_player' | 'thinking_ai';
  turn: number;
  difficulty: AIDifficulty;
  gameMode: GameMode;
  startTime: number;
  rootMoves: WorkerRootCandidate[];
  worldWeights: number[];
  worldsCount: number;
  currentDepth: number;
  quiescenceDepth: number;
  completedDepth: number;
  maxTreeDepth: number;
  sessionInitialized: boolean;
  pendingTasks: PendingTask[];
  inFlightTasks: number;
  candAccumulators: DepthCandidateAccumulator[];
  committedBestMove: { unitId: string; toQ: number; toR: number; score: number; baseScore: number } | null;
  committedBestScore: number;
  predictedPlayerMoveText: string;
  plannedCounterMoveText: string;
  pvLineText: string;
  sessionNodes: number;
}

export class AIMultiCorePool {
  public readonly workerCount: number;
  private workers: WorkerSlot[] = [];
  private aiEngine: StrategoAIEngine;
  private onTelemetry: (() => void) | null;
  private lastTelemetryTime = 0;

  private nextSessionId = 1;
  private nextTaskId = 1;
  private session: PoolSession | null = null;
  private ponderResponseBook: Map<string, PonderReplyEntry> = new Map();
  private ponderTimer: ReturnType<typeof setTimeout> | null = null;
  private turnResolveCheck: (() => void) | null = null;

  constructor(aiEngine: StrategoAIEngine, onTelemetry?: () => void) {
    this.aiEngine = aiEngine;
    this.onTelemetry = onTelemetry || null;

    const detectedCores =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
    // Use 2..8 parallel Web Workers across available CPU cores
    this.workerCount = Math.max(2, Math.min(8, detectedCores));

    this.initWorkers();
  }

  private initWorkers(): void {
    if (typeof Worker === 'undefined') return;

    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), {
        type: 'module'
      });
      const slot: WorkerSlot = {
        index: i,
        worker,
        busy: false,
        readySessionId: 0,
        ttSize: 0,
        ttHits: 0,
        totalNodes: 0
      };
      worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
        this.handleWorkerMessage(slot, ev.data);
      };
      this.workers.push(slot);
    }
  }

  public setTelemetryCallback(cb: (() => void) | null): void {
    this.onTelemetry = cb;
  }

  public reset(): void {
    if (this.ponderTimer) {
      clearTimeout(this.ponderTimer);
      this.ponderTimer = null;
    }
    this.session = null;
    this.ponderResponseBook.clear();
    this.aiEngine.reset();

    for (const w of this.workers) {
      w.busy = false;
      w.readySessionId = 0;
      w.ttSize = 0;
      w.ttHits = 0;
      w.totalNodes = 0;
      const msg: WorkerInMessage = { type: 'RESET' };
      w.worker.postMessage(msg);
    }
  }

  /**
   * Synchronizes the current board state with the Multi-Core Web Worker Pool.
   * Non-blocking (0ms search on the Main Thread).
   */
  public syncState(
    units: Unit[],
    tiles: Map<string, HexTile>,
    phase: string,
    turn: number,
    difficulty: AIDifficulty,
    gameMode: GameMode
  ): void {
    if (phase === 'game_over' || units.length === 0 || this.workers.length === 0) {
      if (this.ponderTimer) {
        clearTimeout(this.ponderTimer);
        this.ponderTimer = null;
      }
      return;
    }

    const sideToMove: Faction = phase === 'ai_turn' ? 'ai' : 'player';
    const ponderPhase: 'setup_analysis' | 'pondering_player' | 'thinking_ai' =
      phase === 'setup'
        ? 'setup_analysis'
        : phase === 'ai_turn'
        ? 'thinking_ai'
        : 'pondering_player';

    const boardSig = this.aiEngine.computeBoardSignature(units, sideToMove, difficulty, gameMode);

    if (this.session && this.session.boardSignature === boardSig) {
      const prevPhase = this.session.phase;
      this.session.phase = ponderPhase;
      this.session.units = units.map(u => ({ ...u }));
      if (prevPhase !== ponderPhase) {
        this.updateStatsAndNotify(false);
        this.scheduleTasks();
      }
      return;
    }

    // Board state changed -> start a new parallel search session across all workers
    if (this.ponderTimer) {
      clearTimeout(this.ponderTimer);
      this.ponderTimer = null;
    }

    const sessionId = ++this.nextSessionId;
    const maxTreeDepth = difficulty === 'ultra' ? 15 : difficulty === 'hard' ? 8 : 5;
    const clonedUnits = units.map(u => ({ ...u }));
    const tilesArray = Array.from(tiles.values()).map(t => ({ ...t }));

    const lastPlayerKey = this.aiEngine.getLastKnownPlayerMoveKey();
    const precomputedReply = lastPlayerKey ? this.ponderResponseBook.get(lastPlayerKey) : undefined;

    this.session = {
      sessionId,
      boardSignature: boardSig,
      units: clonedUnits,
      sideToMove,
      phase: ponderPhase,
      turn,
      difficulty,
      gameMode,
      startTime: performance.now(),
      rootMoves: [],
      worldWeights: [0.45, 0.25, 0.15, 0.15],
      worldsCount: 4,
      currentDepth: 2,
      quiescenceDepth: 3,
      completedDepth: 1,
      maxTreeDepth,
      sessionInitialized: false,
      pendingTasks: [],
      inFlightTasks: 0,
      candAccumulators: [],
      committedBestMove: null,
      committedBestScore: 0,
      predictedPlayerMoveText: 'Analysiere Frontlinie...',
      plannedCounterMoveText: 'Berechne Konter...',
      pvLineText: '',
      sessionNodes: 0
    };

    const engineState = this.aiEngine.exportEngineState();
    const sessionSeed = ((turn * 2654435761) ^ (sessionId * 1597334677)) >>> 0;

    for (const w of this.workers) {
      const msg: WorkerInMessage = {
        type: 'SYNC_SESSION',
        sessionId,
        units: clonedUnits,
        tilesArray,
        sideToMove,
        turn,
        difficulty,
        gameMode,
        sessionSeed,
        engineState,
        precomputedReply
      };
      w.worker.postMessage(msg);
    }
  }

  /**
   * Asynchronously selects the strongest AI move using all Web Workers in parallel.
   * Keeps the Main Thread 100% responsive so 3D animations and camera never stutter.
   */
  public async selectBestMoveAsync(
    units: Unit[],
    tiles: Map<string, HexTile>,
    turn: number,
    difficulty: AIDifficulty,
    getValidMovesFn: (u: Unit) => AxialCoord[],
    gameMode: GameMode = 'classic'
  ): Promise<{ unit: Unit; toQ: number; toR: number } | null> {
    // Fallback if Web Workers are unavailable
    if (this.workers.length === 0) {
      return this.aiEngine.selectBestMove(units, tiles, turn, difficulty, getValidMovesFn, gameMode);
    }

    // Ensure session is synced for 'ai_turn'
    this.syncState(units, tiles, 'ai_turn', turn, difficulty, gameMode);
    const activeSession = this.session;
    if (!activeSession) return null;

    activeSession.phase = 'thinking_ai';
    this.scheduleTasks();

    const timeBudget = difficulty === 'ultra' ? 300 : difficulty === 'hard' ? 160 : 75;

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.turnResolveCheck = null;
        clearTimeout(timer);
        resolve();
      };

      const checkEarlyExit = () => {
        if (!this.session || this.session.sessionId !== activeSession.sessionId) {
          finish();
          return;
        }
        if (this.session.sessionInitialized && this.session.rootMoves.length === 0) {
          finish();
          return;
        }
        // Immediate flag capture win
        if (
          this.session.committedBestMove &&
          this.session.committedBestMove.baseScore >= 45000
        ) {
          finish();
          return;
        }
        // Reached max iterative deepening horizon
        if (
          this.session.sessionInitialized &&
          this.session.currentDepth > this.session.maxTreeDepth
        ) {
          finish();
        }
      };

      this.turnResolveCheck = checkEarlyExit;
      const timer = setTimeout(finish, timeBudget);
      checkEarlyExit();
    });

    if (!this.session || this.session.sessionId !== activeSession.sessionId) {
      return null;
    }

    // If depth 2 was still in flight when timer expired, check if any candidate already finished all worlds
    if (this.session.completedDepth < 2 && this.session.candAccumulators.length > 0) {
      this.tryCommitPartialDepth(this.session);
    }

    const best = this.session.committedBestMove;
    if (best) {
      const realUnit = units.find(u => u.id === best.unitId);
      if (realUnit) {
        const validMoves = getValidMovesFn(realUnit);
        if (validMoves.some(m => m.q === best.toQ && m.r === best.toR)) {
          return { unit: realUnit, toQ: best.toQ, toR: best.toR };
        }
      }
    }

    // Fallback: pick first legal move from rootMoves or movable units
    for (const rm of this.session.rootMoves) {
      const realUnit = units.find(u => u.id === rm.unitId);
      if (realUnit) {
        const validMoves = getValidMovesFn(realUnit);
        if (validMoves.some(m => m.q === rm.toQ && m.r === rm.toR)) {
          return { unit: realUnit, toQ: rm.toQ, toR: rm.toR };
        }
      }
    }

    for (const u of units) {
      if (u.faction === 'ai' && UNIT_DEFINITIONS[u.type].canMove) {
        const vm = getValidMovesFn(u);
        if (vm.length > 0) {
          return { unit: u, toQ: vm[0].q, toR: vm[0].r };
        }
      }
    }

    return null;
  }

  private handleWorkerMessage(slot: WorkerSlot, msg: WorkerOutMessage): void {
    if (msg.type === 'SESSION_READY') {
      slot.readySessionId = msg.sessionId;
      slot.busy = false;

      if (!this.session || this.session.sessionId !== msg.sessionId) {
        return;
      }

      if (!this.session.sessionInitialized) {
        this.session.sessionInitialized = true;
        this.session.rootMoves = msg.rootMoves;
        this.session.worldWeights = msg.worldWeights;
        this.session.worldsCount = msg.worldsCount;
        this.session.committedBestScore = msg.initialStaticScore;

        if (msg.rootMoves.length > 0) {
          const top = msg.rootMoves[0];
          this.session.committedBestMove = {
            unitId: top.unitId,
            toQ: top.toQ,
            toR: top.toR,
            score: top.baseScore >= 45000 ? 45000 : msg.initialStaticScore,
            baseScore: top.baseScore
          };

          // Immediate win check (capturing revealed Flag)
          if (this.session.sideToMove === 'ai' && top.baseScore >= 45000) {
            const mover = this.session.units.find(u => u.id === top.unitId);
            this.session.plannedCounterMoveText = `🔴 ${this.aiEngine.formatMoveLabel(
              mover,
              top.toQ,
              top.toR,
              false
            )}`;
            this.session.pvLineText = 'Direkter Sieg: Flaggeneroberung!';
            this.session.completedDepth = 1;
            this.session.currentDepth = this.session.maxTreeDepth + 1;
            this.updateStatsAndNotify(true);
            if (this.turnResolveCheck) this.turnResolveCheck();
            return;
          }

          this.prepareDepthTasks(this.session);
        } else {
          this.session.currentDepth = this.session.maxTreeDepth + 1;
        }
        this.updateStatsAndNotify(true);
      }

      this.scheduleTasks();
      if (this.turnResolveCheck) this.turnResolveCheck();
      return;
    }

    if (msg.type === 'TASK_RESULT') {
      slot.busy = false;
      slot.ttHits = msg.ttHits;
      slot.ttSize = msg.ttSize;
      slot.totalNodes += msg.nodes;

      if (!this.session || this.session.sessionId !== msg.sessionId) {
        this.scheduleTasks();
        return;
      }

      const s = this.session;
      s.inFlightTasks = Math.max(0, s.inFlightTasks - 1);
      s.sessionNodes += msg.nodes;

      const acc = s.candAccumulators[msg.candIdx];
      const cand = s.rootMoves[msg.candIdx];
      if (acc && cand) {
        const weight = s.worldWeights[msg.worldIdx] ?? 1 / s.worldsCount;
        acc.expectedScore += msg.wScore * weight;
        if (s.sideToMove === 'ai') {
          if (msg.wScore < acc.worstScore) acc.worstScore = msg.wScore;
        } else {
          if (msg.wScore > acc.worstScore) acc.worstScore = msg.wScore;
        }
        acc.completedWorlds++;

        if (msg.aiPvLine && msg.worldIdx === 0) {
          acc.aiPvLine = msg.aiPvLine;
        }

        if (s.sideToMove === 'player' && msg.worldIdx === 0 && msg.replyEntry) {
          const pmKey = `${cand.unitId}:${cand.toQ},${cand.toR}`;
          this.ponderResponseBook.set(pmKey, msg.replyEntry);
        }
      }

      // Check if all tasks for `s.currentDepth` have completed
      if (s.pendingTasks.length === 0 && s.inFlightTasks === 0) {
        this.commitCompletedDepth(s);
      } else {
        this.updateStatsAndNotify(false);
      }

      if (this.turnResolveCheck) {
        this.turnResolveCheck();
      }

      // Schedule next tasks across workers
      if (s.currentDepth <= s.maxTreeDepth) {
        if (s.phase === 'thinking_ai') {
          this.scheduleTasks();
        } else {
          // Gentle pacing during background pondering so CPU cores share load smoothly without 100% pegging
          if (!this.ponderTimer) {
            this.ponderTimer = setTimeout(() => {
              this.ponderTimer = null;
              this.scheduleTasks();
            }, 8);
          }
        }
      }
    }
  }

  private prepareDepthTasks(s: PoolSession): void {
    s.pendingTasks = [];
    s.inFlightTasks = 0;
    s.candAccumulators = s.rootMoves.map(() => ({
      expectedScore: 0,
      worstScore: s.sideToMove === 'ai' ? Infinity : -Infinity,
      completedWorlds: 0
    }));

    for (let candIdx = 0; candIdx < s.rootMoves.length; candIdx++) {
      const candMove = s.rootMoves[candIdx];
      for (let worldIdx = 0; worldIdx < s.worldsCount; worldIdx++) {
        s.pendingTasks.push({
          taskId: ++this.nextTaskId,
          candIdx,
          worldIdx,
          candMove
        });
      }
    }
  }

  private commitCompletedDepth(s: PoolSession): void {
    let bestIdx = 0;
    let bestScore = s.sideToMove === 'ai' ? -Infinity : Infinity;

    for (let i = 0; i < s.rootMoves.length; i++) {
      const cand = s.rootMoves[i];
      const acc = s.candAccumulators[i];
      if (!acc || acc.completedWorlds === 0) continue;

      if (s.sideToMove === 'ai') {
        const regretAdjusted = 0.72 * acc.expectedScore + 0.28 * acc.worstScore;
        const combined = cand.baseScore * 0.48 + regretAdjusted * 0.52;
        if (combined > bestScore) {
          bestScore = combined;
          bestIdx = i;
        }
      } else {
        const playerScore = 0.75 * acc.expectedScore + 0.25 * acc.worstScore;
        if (playerScore < bestScore) {
          bestScore = playerScore;
          bestIdx = i;
        }
      }
    }

    const bestCand = s.rootMoves[bestIdx];
    const bestAcc = s.candAccumulators[bestIdx];
    if (bestCand) {
      s.completedDepth = s.currentDepth + 1 + s.quiescenceDepth;
      s.committedBestScore = bestScore;
      s.committedBestMove = {
        unitId: bestCand.unitId,
        toQ: bestCand.toQ,
        toR: bestCand.toR,
        score: bestScore,
        baseScore: bestCand.baseScore
      };

      const mover = s.units.find(u => u.id === bestCand.unitId);
      if (s.sideToMove === 'player') {
        s.predictedPlayerMoveText = `🔵 ${this.aiEngine.formatMoveLabel(
          mover,
          bestCand.toQ,
          bestCand.toR,
          false
        )}`;
        const replyKey = `${bestCand.unitId}:${bestCand.toQ},${bestCand.toR}`;
        const reply = this.ponderResponseBook.get(replyKey);
        if (reply) {
          const aiUnit = s.units.find(u => u.id === reply.aiUnitId);
          s.plannedCounterMoveText = `🔴 ${this.aiEngine.formatMoveLabel(
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
        const firstStep = `🔴 ${this.aiEngine.formatMoveLabel(
          mover,
          bestCand.toQ,
          bestCand.toR,
          true
        )}`;
        const restPV = bestAcc?.aiPvLine || '';
        s.plannedCounterMoveText = firstStep;
        s.pvLineText = restPV ? `${firstStep} → ${restPV}` : firstStep;
      }

      // PV Move Ordering: promote best candidate to index 0 for the next deeper iteration
      if (bestIdx > 0) {
        const [top] = s.rootMoves.splice(bestIdx, 1);
        s.rootMoves.unshift(top);
      }
    }

    s.currentDepth++;
    if (s.currentDepth <= s.maxTreeDepth) {
      this.prepareDepthTasks(s);
    }

    this.updateStatsAndNotify(true);
  }

  private tryCommitPartialDepth(s: PoolSession): void {
    let bestIdx = -1;
    let bestScore = s.sideToMove === 'ai' ? -Infinity : Infinity;

    for (let i = 0; i < s.rootMoves.length; i++) {
      const cand = s.rootMoves[i];
      const acc = s.candAccumulators[i];
      if (!acc || acc.completedWorlds < s.worldsCount) continue;

      if (s.sideToMove === 'ai') {
        const regretAdjusted = 0.72 * acc.expectedScore + 0.28 * acc.worstScore;
        const combined = cand.baseScore * 0.48 + regretAdjusted * 0.52;
        if (combined > bestScore) {
          bestScore = combined;
          bestIdx = i;
        }
      }
    }

    if (bestIdx >= 0) {
      const bestCand = s.rootMoves[bestIdx];
      s.committedBestScore = bestScore;
      s.committedBestMove = {
        unitId: bestCand.unitId,
        toQ: bestCand.toQ,
        toR: bestCand.toR,
        score: bestScore,
        baseScore: bestCand.baseScore
      };
    }
  }

  /**
   * Dispatches pending (candidateMove, worldIdx) tasks to all idle Web Workers.
   * Uses World Affinity (Worker i prefers worldIdx = i % worldsCount) to maximize Zobrist TT cache hits,
   * with automatic Work Stealing when a worker finishes its preferred world early!
   */
  private scheduleTasks(): void {
    const s = this.session;
    if (!s || !s.sessionInitialized || s.currentDepth > s.maxTreeDepth) return;
    if (s.pendingTasks.length === 0) return;

    const budgetMs = s.phase === 'thinking_ai' ? 32 : 20;

    for (const w of this.workers) {
      if (w.busy || w.readySessionId !== s.sessionId) continue;
      if (s.pendingTasks.length === 0) break;

      const preferredWorld = w.index % s.worldsCount;
      let taskIdx = s.pendingTasks.findIndex(t => t.worldIdx === preferredWorld);
      if (taskIdx === -1) {
        taskIdx = 0; // Work stealing from another world queue
      }

      const [task] = s.pendingTasks.splice(taskIdx, 1);
      w.busy = true;
      s.inFlightTasks++;

      const msg: WorkerInMessage = {
        type: 'EVAL_TASK',
        sessionId: s.sessionId,
        taskId: task.taskId,
        candIdx: task.candIdx,
        worldIdx: task.worldIdx,
        candMove: task.candMove,
        depth: s.currentDepth,
        quiescenceDepth: s.quiescenceDepth,
        budgetMs
      };
      w.worker.postMessage(msg);
    }
  }

  private updateStatsAndNotify(forceNotify: boolean): void {
    const s = this.session;
    if (!s) return;

    const elapsedMs = Math.max(1, Math.round(performance.now() - s.startTime));
    const nps = Math.round((s.sessionNodes / elapsedMs) * 1000);
    const { evalForPlayer, playerWinProb } = this.aiEngine.computeEvalMetrics(
      s.committedBestScore,
      s.units
    );

    let totalNodesAllTime = 0;
    let totalTtHits = 0;
    let totalTtSize = 0;
    let activeWorkers = 0;

    for (const w of this.workers) {
      totalNodesAllTime += w.totalNodes;
      totalTtHits += w.ttHits;
      totalTtSize += w.ttSize;
      if (w.busy) activeWorkers++;
    }

    const isPondering = s.currentDepth <= s.maxTreeDepth;
    const depthReached = Math.max(s.completedDepth, 4);
    const targetDepth = Math.min(
      s.maxTreeDepth + 1 + s.quiescenceDepth,
      s.currentDepth + 1 + s.quiescenceDepth
    );

    const stats: AISearchStats = {
      difficulty: s.difficulty,
      isPondering,
      ponderPhase: s.phase,
      depthReached,
      targetDepth,
      quiescenceDepth: s.quiescenceDepth,
      nodesEvaluated: s.sessionNodes,
      totalNodesAllTime,
      nodesPerSecond: nps,
      ttHits: totalTtHits,
      ttSize: totalTtSize,
      worldsSampled: s.worldsCount,
      bestScore: Math.round(s.committedBestScore),
      evalForPlayer,
      playerWinProb,
      timeMs: elapsedMs,
      predictedPlayerMove: s.predictedPlayerMoveText,
      plannedCounterMove: s.plannedCounterMoveText,
      pvLine: s.pvLineText || 'Berechne Hauptvariante (PV)...',
      tacticalSummary:
        s.phase === 'pondering_player'
          ? `Multi-Core Pondering (${this.workerCount} Kerne) • Tiefe ${depthReached} Halbzüge`
          : s.phase === 'setup_analysis'
          ? `Multi-Core Vorab-Analyse (${this.workerCount} Kerne) • Tiefe ${depthReached} Halbzüge`
          : `Multi-Core KI-Tiefensuche (${this.workerCount} Kerne) • Tiefe ${depthReached} Halbzüge`,
      workerCount: this.workerCount,
      activeWorkers
    };

    this.aiEngine.lastSearchStats = stats;

    const now = performance.now();
    if (forceNotify || now - this.lastTelemetryTime > 160) {
      this.lastTelemetryTime = now;
      if (this.onTelemetry) {
        this.onTelemetry();
      }
    }
  }
}
