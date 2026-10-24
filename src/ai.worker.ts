import {
  AIMoveRecord,
  PonderReplyEntry,
  StrategoAIEngine,
  UnitSuspicion,
  WorkerRootCandidate
} from './ai';
import { coordKey } from './hex';
import { AIDifficulty, Faction, GameMode, HexTile, Unit } from './types';

export type WorkerInMessage =
  | { type: 'RESET' }
  | {
      type: 'SYNC_SESSION';
      sessionId: number;
      units: Unit[];
      tilesArray: HexTile[];
      sideToMove: Faction;
      turn: number;
      difficulty: AIDifficulty;
      gameMode: GameMode;
      sessionSeed: number;
      engineState: {
        suspicions: [string, UnitSuspicion][];
        moveHistory: AIMoveRecord[];
        lastKnownPlayerMoveKey: string | null;
        ttAge: number;
      };
      precomputedReply?: PonderReplyEntry;
    }
  | {
      type: 'EVAL_TASK';
      sessionId: number;
      taskId: number;
      candIdx: number;
      worldIdx: number;
      candMove: WorkerRootCandidate;
      depth: number;
      quiescenceDepth: number;
      budgetMs: number;
    };

export type WorkerOutMessage =
  | {
      type: 'SESSION_READY';
      sessionId: number;
      rootMoves: WorkerRootCandidate[];
      worldWeights: number[];
      worldsCount: number;
      initialStaticScore: number;
    }
  | {
      type: 'TASK_RESULT';
      sessionId: number;
      taskId: number;
      candIdx: number;
      worldIdx: number;
      wScore: number;
      nodes: number;
      ttHits: number;
      ttSize: number;
      replyEntry?: PonderReplyEntry;
      aiPvLine?: string;
    };

const engine = new StrategoAIEngine();
let activeSessionId = 0;

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'RESET') {
    activeSessionId = 0;
    engine.reset();
    return;
  }

  if (msg.type === 'SYNC_SESSION') {
    activeSessionId = msg.sessionId;
    engine.importEngineState(msg.engineState);

    const tilesMap = new Map<string, HexTile>();
    for (const t of msg.tilesArray) {
      tilesMap.set(coordKey(t.q, t.r), t);
    }

    const prep = engine.initWorkerSession(
      msg.units,
      tilesMap,
      msg.sideToMove,
      msg.turn,
      msg.difficulty,
      msg.gameMode,
      msg.sessionSeed,
      msg.precomputedReply
    );

    const reply: WorkerOutMessage = {
      type: 'SESSION_READY',
      sessionId: msg.sessionId,
      rootMoves: prep.rootMoves,
      worldWeights: prep.worldWeights,
      worldsCount: prep.worldsCount,
      initialStaticScore: prep.initialStaticScore
    };
    self.postMessage(reply);
    return;
  }

  if (msg.type === 'EVAL_TASK') {
    if (msg.sessionId !== activeSessionId) {
      return;
    }

    const res = engine.evaluateWorkerTask(
      msg.candMove,
      msg.worldIdx,
      msg.depth,
      msg.quiescenceDepth,
      msg.budgetMs
    );

    const reply: WorkerOutMessage = {
      type: 'TASK_RESULT',
      sessionId: msg.sessionId,
      taskId: msg.taskId,
      candIdx: msg.candIdx,
      worldIdx: msg.worldIdx,
      wScore: res.wScore,
      nodes: res.nodes,
      ttHits: res.ttHits,
      ttSize: res.ttSize,
      replyEntry: res.replyEntry,
      aiPvLine: res.aiPvLine
    };
    self.postMessage(reply);
  }
};
