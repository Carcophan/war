import './style.css';
import { HexStrategoGame } from './game';
import { HexRenderer } from './renderer';
import { GameMode, ORDERED_UNIT_TYPES, PROMOTION_CHAIN, UNIT_DEFINITIONS, UnitType } from './types';
import { sound } from './audio';
import { getInsigniaSVG } from './insignia';

const app = document.getElementById('app')!;

app.innerHTML = `
  <header class="top-bar">
    <div class="brand">
      <span class="brand-logo">⬢</span>
      <h1>Hex-Stratego <span class="badge-3d">3D WebGL</span></h1>
    </div>

    <div id="status-banner" class="status-banner setup-phase" style="cursor: pointer;" title="Klicke hier oder links auf 'Schlacht starten!'">
      Aufstellungsphase
    </div>

    <div id="top-score-pill" class="top-score-pill" title="Aktueller Gefechts-Score, Stellungsbewertung & Siege">
      <span class="ts-blue">🔵 0 Pkt</span>
      <span class="ts-eval">⚖️ 0.00</span>
      <span class="ts-red">🔴 0 Pkt</span>
    </div>

    <div class="controls-bar">
      <button id="btn-game-mode" class="btn" title="Spielmodus wechseln">🎮 Modus: Klassisch</button>
      <button id="btn-ai-diff" class="btn btn-ultra" title="KI-Stärke umschalten (Normal / Stark / Ultra Spieltheorie)">🔥 KI: Ultra (Spieltheorie)</button>
      <button id="btn-fog" class="btn" title="KI-Einheiten zu Testzwecken aufdecken">👁️ Nebel: AN</button>
      <button id="btn-sound" class="btn" title="Soundeffekte an/aus">🔊 Ton: AN</button>
      <button id="btn-new-game" class="btn btn-primary">🔄 Neues Spiel</button>
    </div>
  </header>

  <main class="workspace">
    <!-- Left Sidebar: Setup & Unit Roster -->
    <aside class="side-panel">
      <div class="panel-section">
        <div class="panel-title">
          <span>🎮 Spielmodus</span>
        </div>
        <div class="mode-selector">
          <button id="btn-mode-classic" class="mode-card active">
            <span class="mode-title">⚔️ Klassisch</span>
            <span class="mode-sub">Alle 12 Bundeswehr-Ränge</span>
          </button>
          <button id="btn-mode-scouts" class="mode-card">
            <span class="mode-title">⬆️ Spähtrupp-Karriere</span>
            <span class="mode-sub">Nur Flagge, Bomben & Aufklärer (Level-Up!)</span>
          </button>
        </div>
      </div>

      <div id="setup-section" class="panel-section">
        <div class="panel-title">
          <span>⚙️ Aufstellung (Blau)</span>
        </div>
        <div class="setup-controls">
          <p class="setup-hint">
            Ziehe deine blauen 3D-Einheiten per <strong>Drag & Drop</strong> (oder Klick), um ihre Startplätze zu tauschen:
          </p>
          <div class="setup-btn-row">
            <button id="btn-auto-deploy" class="btn">🎲 Zufällig</button>
            <button id="btn-clear-deploy" class="btn">🧹 Leeren</button>
          </div>
          <button id="btn-start-battle" class="btn btn-accent" style="width: 100%; justify-content: center; margin-top: 0.25rem; padding: 0.6rem;">
            ⚔️ Schlacht starten!
          </button>
        </div>
      </div>

      <div class="panel-section" style="flex: 1; display: flex; flex-direction: column;">
        <div class="panel-title">
          <span>📋 Einheiten & Ränge</span>
          <span><span style="color:#93c5fd">Blau</span> / <span style="color:#fca5a5">KI</span></span>
        </div>
        <div id="unit-roster" class="unit-roster"></div>
      </div>
    </aside>

    <!-- Center 3D WebGL Hex Canvas -->
    <section class="board-container">
      <div id="combat-overlay"></div>

      <!-- 3D Camera Controls HUD -->
      <div class="camera-hud">
        <button id="btn-cam-3d" class="cam-btn active" title="Standard 3D-Kommandanten-Ansicht">🎥 3D-Ansicht</button>
        <button id="btn-cam-top" class="cam-btn" title="Taktische 2D/3D Draufsicht von oben">📐 Draufsicht</button>
        <button id="btn-cam-cine" class="cam-btn" title="Flacher Kino-Winkel">🎬 Nahansicht</button>
        <span class="cam-divider"></span>
        <button id="btn-cam-zoom-in" class="cam-btn" title="Heranzoomen">➕</button>
        <button id="btn-cam-zoom-out" class="cam-btn" title="Herauszoomen">➖</button>
        <button id="btn-cam-reset" class="cam-btn" title="Kamera zurücksetzen">🔄 Reset</button>
      </div>

      <div class="camera-hint">
        🖱️ <strong>Links:</strong> 3D-Einheit wählen / ziehen &nbsp;•&nbsp; <strong>Rechtsklick + Ziehen:</strong> 3D-Kamera frei drehen &nbsp;•&nbsp; <strong>Mausrad:</strong> Zoom
      </div>

      <canvas id="hex-canvas"></canvas>
    </section>

    <!-- Right Sidebar: Scoreboard, AI Permanent-Brain, Unit Info, Rules & Combat Log -->
    <aside class="side-panel right">
      <div class="panel-section score-section">
        <div class="panel-title">
          <span>📊 Score & Stellungsbewertung</span>
          <span id="match-wins-badge" class="match-wins-pill" title="Gesamtsiege in dieser Sitzung">🏆 0 : 0</span>
        </div>
        <div id="score-board-box" class="score-board-box"></div>
      </div>

      <div class="panel-section">
        <div class="panel-title">
          <span>🧠 Permanent-Brain KI</span>
          <span id="ai-badge-pill" class="ai-mode-pill ultra">ULTRA • 18-PLY</span>
        </div>
        <div id="ai-telemetry" class="ai-telemetry-box"></div>
      </div>

      <div class="panel-section">
        <div class="panel-title">🔍 Einheiten-Details</div>
        <div id="unit-detail" class="unit-detail-card">
          Klicke auf eine Einheit in der Liste oder auf dem 3D-Spielfeld, um ihre Spezialfähigkeiten zu sehen.
        </div>
      </div>

      <div class="panel-section">
        <div id="rules-title" class="panel-title">📜 Stratego-Hex Regeln (Bundeswehr)</div>
        <ul id="rules-list" class="rules-list">
          <li><strong>Ziel:</strong> Erobere die feindliche <strong>Kommandoflagge</strong> oder vernichte alle beweglichen Einheiten der KI.</li>
          <li><strong>Verdeckte Ränge:</strong> Feindliche 3D-Monolithen sind verdeckt (<strong>?</strong>), bis es zum Kampf kommt!</li>
          <li><strong>Dienstgrade:</strong> Der höhere Dienstgrad (10 = General bis 1 = Gefreiter) gewinnt. Bei Gleichstand fallen beide.</li>
          <li><strong>Landminen / Bomben:</strong> Unbeweglich. Vernichten jeden Angreifer – <em>außer</em> den <strong>Pionier (Rang 3, StGefr)</strong>!</li>
          <li><strong>Spion (Rang 1, Gefr):</strong> Schwächste Einheit, aber schlägt den <strong>General (Rang 10, 4★)</strong>, wenn der Spion selbst angreift!</li>
          <li><strong>Aufklärer (Rang 2, OGefr):</strong> Kann bis zu 4 Hex-Felder weit in gerader Linie ziehen & angreifen!</li>
        </ul>
      </div>

      <div class="panel-section" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
        <div class="panel-title">⚔️ Gefechtsprotokoll</div>
        <div id="battle-log" class="log-list"></div>
      </div>
    </aside>
  </main>

  <div id="game-over-modal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <h2 id="modal-title">Sieg!</h2>
      <p id="modal-desc"></p>
      <button id="btn-modal-restart" class="btn btn-primary" style="justify-content: center; padding: 0.7rem;">
        🔄 Neue Schlacht spielen
      </button>
    </div>
  </div>
`;

const canvas = document.getElementById('hex-canvas') as HTMLCanvasElement;
let renderer: HexRenderer | null = null;
let inspectedType: UnitType = 'marshal';

const game = new HexStrategoGame(
  () => {
    updateUI();
    if (renderer) {
      renderer.render();
    }
  },
  () => {
    updateScoreAndTelemetryUI();
  }
);

game.initNewGame(false);
renderer = new HexRenderer(canvas, game);
updateUI();

// Button Listeners
document.getElementById('btn-new-game')!.addEventListener('click', () => {
  game.initNewGame(true);
});

document.getElementById('btn-modal-restart')!.addEventListener('click', () => {
  game.initNewGame(true);
});

document.getElementById('btn-auto-deploy')!.addEventListener('click', () => {
  game.autoDeployPlayer();
});

document.getElementById('btn-clear-deploy')!.addEventListener('click', () => {
  game.clearPlayerDeployment();
});

document.getElementById('btn-start-battle')!.addEventListener('click', () => {
  game.startBattle();
});

document.getElementById('status-banner')!.addEventListener('click', () => {
  if (game.phase === 'setup' && game.isPlayerSetupComplete()) {
    game.startBattle();
  }
});

// 3D Camera Preset Buttons
const camBtns = [
  document.getElementById('btn-cam-3d')!,
  document.getElementById('btn-cam-top')!,
  document.getElementById('btn-cam-cine')!
];
function setActiveCamBtn(activeBtn: HTMLElement | null): void {
  camBtns.forEach(b => b.classList.toggle('active', b === activeBtn));
}

document.getElementById('btn-cam-3d')!.addEventListener('click', e => {
  renderer?.setCameraPreset('perspective');
  setActiveCamBtn(e.currentTarget as HTMLElement);
});

document.getElementById('btn-cam-top')!.addEventListener('click', e => {
  renderer?.setCameraPreset('topdown');
  setActiveCamBtn(e.currentTarget as HTMLElement);
});

document.getElementById('btn-cam-cine')!.addEventListener('click', e => {
  renderer?.setCameraPreset('cinematic');
  setActiveCamBtn(e.currentTarget as HTMLElement);
});

document.getElementById('btn-cam-zoom-in')!.addEventListener('click', () => {
  renderer?.zoomCamera(-1.6);
});

document.getElementById('btn-cam-zoom-out')!.addEventListener('click', () => {
  renderer?.zoomCamera(1.6);
});

document.getElementById('btn-cam-reset')!.addEventListener('click', () => {
  renderer?.resetCamera();
  setActiveCamBtn(document.getElementById('btn-cam-3d')!);
});

const btnAiDiff = document.getElementById('btn-ai-diff')!;
btnAiDiff.addEventListener('click', () => {
  if (game.aiDifficulty === 'ultra') {
    game.aiDifficulty = 'normal';
  } else if (game.aiDifficulty === 'normal') {
    game.aiDifficulty = 'hard';
  } else {
    game.aiDifficulty = 'ultra';
  }
  updateUI();
});

function switchGameMode(mode: GameMode): void {
  if (mode === 'scouts_only') {
    inspectedType = 'scout';
  }
  game.setGameMode(mode);
}

document.getElementById('btn-game-mode')!.addEventListener('click', () => {
  switchGameMode(game.gameMode === 'classic' ? 'scouts_only' : 'classic');
});

document.getElementById('btn-mode-classic')!.addEventListener('click', () => {
  switchGameMode('classic');
});

document.getElementById('btn-mode-scouts')!.addEventListener('click', () => {
  switchGameMode('scouts_only');
});

const btnFog = document.getElementById('btn-fog')!;
btnFog.addEventListener('click', () => {
  game.debugRevealAI = !game.debugRevealAI;
  btnFog.textContent = game.debugRevealAI ? '👁️ Nebel: AUS' : '👁️ Nebel: AN';
  renderer?.render();
});

const btnSound = document.getElementById('btn-sound')!;
btnSound.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  btnSound.textContent = sound.enabled ? '🔊 Ton: AN' : '🔇 Ton: AUS';
});

function updateScoreAndTelemetryUI(): void {
  const score = game.getScoreSummary();
  const stats = game.getLastAISearchStats();

  // 1. Update Top Score Pill
  const topScorePill = document.getElementById('top-score-pill')!;
  const evalSign = score.evalForPlayer > 0 ? '+' : '';
  const evalClass =
    score.evalForPlayer > 0.35
      ? 'adv-player'
      : score.evalForPlayer < -0.35
      ? 'adv-ai'
      : 'adv-even';

  topScorePill.innerHTML = `
    <span class="ts-blue">🔵 ${score.playerTotalScore.toLocaleString('de-DE')} Pkt <small>(⚔️${score.playerKills})</small></span>
    <span class="ts-eval ${evalClass}" title="Live KI-Stellungsbewertung (Positiv = Vorteil Blau, Negativ = Vorteil KI)">⚖️ ${evalSign}${score.evalForPlayer.toFixed(2)}</span>
    <span class="ts-red">🔴 ${score.aiTotalScore.toLocaleString('de-DE')} Pkt <small>(⚔️${score.aiKills})</small></span>
  `;

  // 2. Update Match Wins Badge & Scoreboard Box
  const matchWinsBadge = document.getElementById('match-wins-badge')!;
  matchWinsBadge.textContent = `🏆 Siege ${score.matchWinsPlayer} : ${score.matchWinsAI}`;

  const scoreBox = document.getElementById('score-board-box')!;
  const playerPct = Math.max(4, Math.min(96, score.playerWinProb));
  const aiPct = 100 - playerPct;
  const advLabel =
    score.evalForPlayer > 0.35
      ? `Vorteil Blau (${evalSign}${score.evalForPlayer.toFixed(2)})`
      : score.evalForPlayer < -0.35
      ? `Vorteil KI (${score.evalForPlayer.toFixed(2)})`
      : `Ausgeglichen (${evalSign}${score.evalForPlayer.toFixed(2)})`;

  scoreBox.innerHTML = `
    <div class="eval-bar-wrap">
      <div class="eval-bar-labels">
        <span class="eval-pct-blue">🔵 ${score.playerWinProb}%</span>
        <span class="eval-adv-text ${evalClass}">${advLabel}</span>
        <span class="eval-pct-red">${100 - score.playerWinProb}% 🔴</span>
      </div>
      <div class="eval-bar-track">
        <div class="eval-bar-fill-blue" style="width: ${playerPct}%"></div>
        <div class="eval-bar-fill-red" style="width: ${aiPct}%"></div>
      </div>
    </div>
    <div class="score-cards-grid">
      <div class="score-side-card player">
        <div class="sc-header">🔵 BLAU (DU)</div>
        <div class="sc-main-val">${score.playerTotalScore.toLocaleString('de-DE')} <small>Pkt</small></div>
        <div class="sc-sub-row"><span>Armee:</span> <strong>${score.playerArmyScore.toLocaleString('de-DE')}</strong></div>
        <div class="sc-sub-row"><span>Kills (${score.playerKills}):</span> <strong>+${score.playerKillPoints.toLocaleString('de-DE')}</strong></div>
      </div>
      <div class="score-side-card ai">
        <div class="sc-header">🔴 ROT (KI)</div>
        <div class="sc-main-val">${score.aiTotalScore.toLocaleString('de-DE')} <small>Pkt</small></div>
        <div class="sc-sub-row"><span>Armee:</span> <strong>${score.aiArmyScore.toLocaleString('de-DE')}</strong></div>
        <div class="sc-sub-row"><span>Kills (${score.aiKills}):</span> <strong>+${score.aiKillPoints.toLocaleString('de-DE')}</strong></div>
      </div>
    </div>
  `;

  // 3. Update Live Permanent-Brain AI Telemetry
  const btnAi = document.getElementById('btn-ai-diff')!;
  const aiBadgePill = document.getElementById('ai-badge-pill')!;
  const aiTelemetryEl = document.getElementById('ai-telemetry')!;

  btnAi.classList.toggle('btn-ultra', game.aiDifficulty === 'ultra');
  const depthReached = stats ? stats.depthReached : 6;
  const targetDepth = stats ? stats.targetDepth : depthReached + 1;
  const kns = stats ? (stats.nodesPerSecond / 1000).toFixed(1) : '0.0';
  const isPondering = stats?.isPondering ?? true;

  if (game.aiDifficulty === 'ultra') {
    btnAi.textContent = '🔥 KI: Ultra (Permanent-Brain)';
    aiBadgePill.textContent = `ULTRA • ${depthReached}-PLY`;
    aiBadgePill.className = 'ai-mode-pill ultra';
  } else if (game.aiDifficulty === 'hard') {
    btnAi.textContent = '🧠 KI: Stark (Permanent-Brain)';
    aiBadgePill.textContent = `STARK • ${depthReached}-PLY`;
    aiBadgePill.className = 'ai-mode-pill hard';
  } else {
    btnAi.textContent = '🧠 KI: Normal';
    aiBadgePill.textContent = `NORMAL • ${depthReached}-PLY`;
    aiBadgePill.className = 'ai-mode-pill normal';
  }

  const phaseStatusText =
    game.phase === 'ai_turn'
      ? '🔥 KI am Zug: Tiefensuche läuft...'
      : game.phase === 'setup'
      ? '🟢 Permanent-Brain: Analysiert Aufstellung im Voraus'
      : '🟢 Permanent-Brain: Denkt während deines Zuges voraus!';

  aiTelemetryEl.innerHTML = `
    <div class="ponder-live-banner ${isPondering ? 'active' : ''}">
      <span class="ponder-dot ${isPondering ? 'pulsing' : ''}"></span>
      <span>${phaseStatusText}</span>
    </div>
    <div class="ai-tech-tags">
      <span class="tech-tag">Iterative Deepening (bis 19-Ply)</span>
      <span class="tech-tag">Zobrist Transposition Table</span>
      <span class="tech-tag">PVS + LMR + Quiescence</span>
      <span class="tech-tag">4 Bayes-Welten</span>
    </div>
    <div class="ai-metrics-grid">
      <div class="ai-metric-item">
        <span class="am-label">Such-Tiefe</span>
        <strong class="am-val">${depthReached} Halbzüge ${isPondering ? `<small>(→${targetDepth})</small>` : ''}</strong>
      </div>
      <div class="ai-metric-item">
        <span class="am-label">Rechenleistung</span>
        <strong class="am-val">${kns} kN/s</strong>
      </div>
      <div class="ai-metric-item">
        <span class="am-label">Knoten (Gesamt)</span>
        <strong class="am-val">${stats ? stats.totalNodesAllTime.toLocaleString('de-DE') : '0'}</strong>
      </div>
      <div class="ai-metric-item">
        <span class="am-label">TT-Cache / Hits</span>
        <strong class="am-val">${stats ? stats.ttSize.toLocaleString('de-DE') : '0'} / ${stats ? stats.ttHits.toLocaleString('de-DE') : '0'}</strong>
      </div>
    </div>
    ${
      stats
        ? `
      <div class="ai-pv-box">
        <div class="pv-row"><span>🎯 Erwarteter Spielerzug:</span> <strong>${stats.predictedPlayerMove}</strong></div>
        <div class="pv-row"><span>⚡ Geplanter KI-Konter:</span> <strong>${stats.plannedCounterMove}</strong></div>
        <div class="pv-line-text" title="Vorausberechnete Hauptvariante (Principal Variation)">🔮 PV: ${stats.pvLine}</div>
      </div>
    `
        : ''
    }
  `;
}

function updateUI(): void {
  // 0. Update Game Mode, Scoreboard & AI Permanent-Brain Telemetry UI
  const btnModeHeader = document.getElementById('btn-game-mode')!;
  btnModeHeader.textContent =
    game.gameMode === 'classic' ? '🎮 Modus: Klassisch' : '🎮 Modus: Spähtrupp';

  updateScoreAndTelemetryUI();

  const btnModeClassic = document.getElementById('btn-mode-classic')!;
  const btnModeScouts = document.getElementById('btn-mode-scouts')!;
  btnModeClassic.classList.toggle('active', game.gameMode === 'classic');
  btnModeScouts.classList.toggle('active', game.gameMode === 'scouts_only');

  const rulesTitle = document.getElementById('rules-title')!;
  const rulesList = document.getElementById('rules-list')!;
  if (game.gameMode === 'scouts_only') {
    rulesTitle.textContent = '📜 Regeln: Spähtrupp-Karriere';
    rulesList.innerHTML = `
      <li><strong>Start-Aufstellung:</strong> Jede Seite startet nur mit <strong>1x Kommandoflagge</strong>, <strong>3x Landminen/Bomben</strong> und <strong>18x Aufklärern (Rang 2)</strong>!</li>
      <li><strong>Aufklärer-Beförderung (Level-Up):</strong> Aufklärer und beförderte Einheiten steigen Rang für Rang auf (R2 Aufklärer → R3 Pionier → R4 Feldwebel → … → R10 General)!</li>
      <li><strong>1. Kampferfahrung (Sofort):</strong> Jeder gewonnene Angriff oder erfolgreiche Abwehrkampf befördert die überlebende Einheit <strong>sofort um +1 Rang</strong>!</li>
      <li><strong>2. Front- & Wald-Aufklärung (2 EP):</strong> Ein Zug nach vorne Richtung Feind oder auf ein <strong>Waldfeld</strong> bringt <strong>+1 EP</strong> (grünes Abzeichen <strong>⬆1</strong>). Bei <strong>2 EP</strong> erfolgt sofort der Rangaufstieg!</li>
      <li><strong>Bomben knacken:</strong> Sobald ein Aufklärer auf <strong>Rang 3 (Pionier)</strong> aufsteigt, kann er feindliche Bomben entschärfen (und steigt dadurch direkt weiter auf Rang 4)!</li>
    `;
  } else {
    rulesTitle.textContent = '📜 Stratego-Hex Regeln (Bundeswehr)';
    rulesList.innerHTML = `
      <li><strong>Ziel:</strong> Erobere die feindliche <strong>Kommandoflagge</strong> oder vernichte alle beweglichen Einheiten der KI.</li>
      <li><strong>Verdeckte Ränge:</strong> Feindliche 3D-Monolithen sind verdeckt (<strong>?</strong>), bis es zum Kampf kommt!</li>
      <li><strong>Dienstgrade:</strong> Der höhere Dienstgrad (10 = General bis 1 = Gefreiter) gewinnt. Bei Gleichstand fallen beide.</li>
      <li><strong>Landminen / Bomben:</strong> Unbeweglich. Vernichten jeden Angreifer – <em>außer</em> den <strong>Pionier (Rang 3, StGefr)</strong>!</li>
      <li><strong>Spion (Rang 1, Gefr):</strong> Schwächste Einheit, aber schlägt den <strong>General (Rang 10, 4★)</strong>, wenn der Spion selbst angreift!</li>
      <li><strong>Aufklärer (Rang 2, OGefr):</strong> Kann bis zu 4 Hex-Felder weit in gerader Linie ziehen & angreifen!</li>
    `;
  }

  // 1. Update Top Status Banner
  const banner = document.getElementById('status-banner')!;
  banner.className = 'status-banner';

  if (game.phase === 'setup') {
    banner.classList.add('setup-phase');
    const totalExpected = game.getDeploymentCoords('player').length;
    const remaining = totalExpected - game.units.filter(u => u.faction === 'player').length;
    banner.textContent =
      remaining > 0
        ? `⚙️ Aufstellung: Noch ${remaining} Einheit(en) platzieren`
        : '⚙️ Aufstellung bereit – Tausche 3D-Einheiten oder klicke "Schlacht starten!"';
  } else if (game.phase === 'player_turn') {
    banner.classList.add('player-turn');
    banner.textContent = `🔵 Runde ${game.turn}: Du bist am Zug (Ziehen oder Klicken)`;
  } else if (
    game.phase === 'ai_turn' ||
    game.phase === 'combat_anim' ||
    game.phase === 'animating_move'
  ) {
    banner.classList.add('ai-turn');
    banner.textContent =
      game.phase === 'combat_anim'
        ? `⚔️ Gefecht läuft...`
        : game.phase === 'animating_move'
        ? `🏃 Einheit rückt vor...`
        : `🔴 Runde ${game.turn}: Computer (KI) überlegt...`;
  } else if (game.phase === 'game_over') {
    banner.textContent = game.winner === 'player' ? '🏆 SIEG FÜR BLAU!' : '💀 NIEDERLAGE!';
  }

  // 2. Setup Panel Visibility & Start Button
  const setupSec = document.getElementById('setup-section')!;
  setupSec.style.display = game.phase === 'setup' ? 'block' : 'none';

  const startBtn = document.getElementById('btn-start-battle') as HTMLButtonElement;
  startBtn.disabled = !game.isPlayerSetupComplete();

  // 3. Update Unit Roster
  const rosterEl = document.getElementById('unit-roster')!;
  const playerAlive = game.getRemainingCounts('player');
  const aiAlive = game.getRemainingCounts('ai');
  const unplaced = game.getUnplacedPlayerCounts();

  // If a unit is selected on the board, inspect its type
  if (game.selectedUnitId) {
    const sel = game.units.find(u => u.id === game.selectedUnitId);
    if (sel) inspectedType = sel.type;
  } else if (game.phase === 'setup' && game.selectedSetupType) {
    inspectedType = game.selectedSetupType;
  }

  rosterEl.innerHTML = ORDERED_UNIT_TYPES.map(type => {
    const def = UNIT_DEFINITIONS[type];
    const isSetupSelected =
      game.phase === 'setup' && game.selectedSetupType === type && unplaced[type] > 0;
    const isInspected = inspectedType === type;
    const rankStr = type === 'flag' ? 'FLG' : type === 'bomb' ? 'BMB' : `R${def.rank}`;

    const rightBadge =
      game.phase === 'setup' && unplaced[type] > 0
        ? `<span class="count-pill player">Noch ${unplaced[type]}x</span>`
        : `<div class="unit-counts">
           <span class="count-pill player" title="Deine verbleibenden">${playerAlive[type]}</span>
           <span class="count-pill ai" title="KI verbleibende">${aiAlive[type]}</span>
         </div>`;

    return `
      <div class="unit-row ${isSetupSelected || isInspected ? 'active-setup' : ''}" data-type="${type}">
        <span class="unit-icon">${getInsigniaSVG(type)}</span>
        <span class="unit-name">${def.name}</span>
        <span class="unit-rank-badge">${rankStr}</span>
        ${rightBadge}
      </div>
    `;
  }).join('');

  rosterEl.querySelectorAll('.unit-row').forEach(row => {
    row.addEventListener('click', () => {
      const t = row.getAttribute('data-type') as UnitType;
      inspectedType = t;
      if (game.phase === 'setup') {
        game.selectedSetupType = t;
        game.selectedUnitId = null;
      }
      updateUI();
      renderer?.render();
    });
  });

  // 4. Update Unit Detail Card
  const detailEl = document.getElementById('unit-detail')!;
  const def = UNIT_DEFINITIONS[inspectedType];
  const rankDisplay =
    def.type === 'flag' ? 'Ziel' : def.type === 'bomb' ? 'Spezial' : `Rang ${def.rank}`;

  let xpInfoHtml = '';
  if (game.gameMode === 'scouts_only' && game.selectedUnitId) {
    const sel = game.units.find(u => u.id === game.selectedUnitId);
    if (sel && sel.faction === 'player' && PROMOTION_CHAIN.includes(sel.type) && sel.type !== 'marshal') {
      const nextIdx = PROMOTION_CHAIN.indexOf(sel.type) + 1;
      const nextDef = UNIT_DEFINITIONS[PROMOTION_CHAIN[nextIdx]];
      const xp = sel.xp ?? 0;
      xpInfoHtml = `
        <div class="xp-progress-box">
          <strong>⬆️ Nächster Rang:</strong> ${nextDef.name} (Rang ${nextDef.rank})<br/>
          <span>Aufklärungs-EP: <strong>${xp} / 2 EP</strong> (oder sofort durch Kampfsieg!)</span>
        </div>
      `;
    }
  }

  detailEl.innerHTML = `
    <div class="unit-detail-header">
      <span class="detail-insignia">${getInsigniaSVG(inspectedType)}</span>
      <span>${def.name} (${rankDisplay})</span>
    </div>
    <p>${def.description}</p>
    ${xpInfoHtml}
  `;

  // 5. Combat Overlay Toast
  const combatOverlay = document.getElementById('combat-overlay')!;
  if (game.activeCombat) {
    const c = game.activeCombat;
    const attDef = UNIT_DEFINITIONS[c.attacker.type];
    const defDef = UNIT_DEFINITIONS[c.defender.type];
    combatOverlay.innerHTML = `
      <div class="combat-toast">
        <div class="combat-versus">
          <div class="combat-card ${c.attacker.faction}">
            <span class="combat-insignia">${getInsigniaSVG(c.attacker.type)}</span>
            <span>${attDef.name} (${attDef.type === 'flag' || attDef.type === 'bomb' ? attDef.shortName : attDef.rank})</span>
          </div>
          <span style="font-weight:900; color:#f59e0b;">⚔️ VS</span>
          <div class="combat-card ${c.defender.faction}">
            <span class="combat-insignia">${getInsigniaSVG(c.defender.type)}</span>
            <span>${defDef.name} (${defDef.type === 'flag' || defDef.type === 'bomb' ? defDef.shortName : defDef.rank})</span>
          </div>
        </div>
        <div class="combat-reason">${c.reason}</div>
      </div>
    `;
  } else {
    combatOverlay.innerHTML = '';
  }

  // 6. Update Battle Log
  const logEl = document.getElementById('battle-log')!;
  logEl.innerHTML = game.logs
    .map(
      entry => `
    <div class="log-item ${entry.faction} ${entry.isCombat ? 'combat' : ''}">
      <strong style="color:#94a3b8">[R${entry.turn}]</strong> ${entry.message}
    </div>
  `
    )
    .join('');

  // 7. Game Over Modal
  const modal = document.getElementById('game-over-modal')!;
  if (game.phase === 'game_over') {
    modal.style.display = 'flex';
    const title = document.getElementById('modal-title')!;
    const desc = document.getElementById('modal-desc')!;
    if (game.winner === 'player') {
      title.textContent = '🏆 Glorreicher Sieg!';
      title.style.color = '#60a5fa';
    } else {
      title.textContent = '💀 Niederlage!';
      title.style.color = '#f87171';
    }
    desc.textContent = game.winReason;
  } else {
    modal.style.display = 'none';
  }
}
