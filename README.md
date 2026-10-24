# ⬢ HEX-STRATEGO (3D WebGL)

> **Taktisches Hexagon-Kriegsspiel mit Bundeswehr-Rangsystem, Three.js 3D-Grafik und Multi-Core Game-Theory KI.**

Hex-Stratego kombiniert die taktische Tiefe und die verborgenen Informationen des Brettspielklassikers **Stratego** mit einem flexiblen **Hexagonal-Spielfeld (Pointy-Top)**, moderner **3D-WebGL-Visualisierung (Three.js)** und einer leistungsstarken **Multi-Core KI** mit Wahrscheinlichkeitsinferenz und Alpha-Beta-Suche.

---

## 🌟 Hauptmerkmale

- ⬢ **Hexagonales Spielfeld & Axialkoordinaten**: Taktische 6-Richtungs-Bewegung auf einem Hex-Grid mit unterschiedlichen Geländetypen (Gras, Wald, Gebirge, Wasserhindernisse).
- 🎥 **Echtes 3D-WebGL mit Three.js**:
  - Dynamische Monolithen-Figuren mit Gravuren und Bundeswehr-Rangabzeichen (Schulterklappen).
  - Volle 3D-Kamerasteuerung (Orbit, Zoom, Neigung, Schnellansichten wie Draufsicht und Kinokamera).
  - Partikeleffekte für Explosionen, Entschärfungen und Rang-Beförderungen.
- 🎖️ **Authentisches Bundeswehr-Rangsystem**:
  - General (10 / 4★), Generalleutnant (9 / 3★), Oberst (8), Major (7), Hauptmann (6), Leutnant (5), Feldwebel (4), Pionier (3), Aufklärer (2), Spion (1), Landmine (11) und Kommandoflagge (0).
  - Automatisch generierte, skalierbare SVG-Insignien nach Bundeswehr-Vorbild.
- 🧠 **Multi-Core Game-Theory KI**:
  - **Web Worker Pool**: Nutzt mehrere CPU-Kerne für parallele Berechnungen im Hintergrund.
  - **Wahrscheinlichkeits-Inferenz**: Schätzt Identitäten gegnerischer Einheiten basierend auf Zugverhalten, Verharren (Minen/Flagge), Bluff-Erkennung und Entropie.
  - **Permanentes Pondering**: Die KI analysiert Stellung, Drohungen und Zugprognosen bereits während der Spieler überlegt.
  - **Schwierigkeitsstufen**: Normal, Stark und Ultra (mit Quiescence-Search und Transpositionstabellen).
  - ⚠️ *Hinweis zu „Ultra“*: Im stärksten Modus lastet die KI über Web Worker alle verfügbaren CPU-Kerne (bis zu 8 Threads) permanent aus. Trotz des hohen Rechenaufwands ist die KI aufgrund des extremen Zustandsraums bei unvollständiger Information nicht übermäßig spielstark – Vorsicht vor hoher System- und Lüfterlast!
- 🎮 **Zwei Spielmodi**:
  - **Klassisch**: Volle Schlachtordnung mit allen 12 Diensträngen und taktischer Aufstellungsphase (Drag & Drop oder Zufallsaufstellung).
  - **Spähtrupp-Karriere (Scouts Only)**: Starte nur mit Aufklärern, Flagge und Bomben – Einheiten sammeln XP durch Siege und steigen in der Ranghierarchie auf!
- 🔊 **Synthetischer Sound & FX**: Web-Audio-Effekte für Märsche, Treffer, Minenexplosionen, Beförderungen und Siege.
- 📊 **Echtzeit-Telemetrie & Match-Score**:
  - Stellungsbewertung (Centipawn-Äquivalente) & Sieg-Wahrscheinlichkeit.
  - Detaillierte KI-Suchstatistiken (Knoten/Sekunde, Tiefe, Transposition Table Hits).
  - Persistenter Sitzungs-Score via LocalStorage.

---

## 🪖 Dienstgrade & Kampfhierarchie

| Rang | Abzeichen | Einheit | Reichweite | Sonderregel / Funktion |
| :---: | :---: | :--- | :---: | :--- |
| **10** | ⭐⭐⭐⭐ | **General (4★)** | 1 Feld | Stärkste Kampfeinheit; kann nur vom Spion geschlagen werden, wenn dieser angreift. |
| **9** | ⭐⭐⭐ | **Generalleutnant (3★)** | 1 Feld | Mächtige Offizierseinheit. |
| **8** | ✦✦✦ | **Oberst** | 1 Feld | Höchster Stabsoffizier. |
| **7** | ✦ | **Major** | 1 Feld | Stabsoffizier. |
| **6** | ◇◇◇ | **Hauptmann** | 1 Feld | Frontoffizier. |
| **5** | ◇ | **Leutnant** | 1 Feld | Zugführer. |
| **4** | ⋀ | **Feldwebel** | 1 Feld | Unteroffizier mit Portepee. |
| **3** | /// | **Pionier (StGefr)** | 1 Feld | **Entschärfer**: Die einzige Einheit, die Landminen schlagen kann! |
| **2** | // | **Aufklärer (OGefr)** | bis zu 4 | **Schnellläufer**: Zieht und attackiert bis zu 4 Hex-Felder weit in gerader Linie. |
| **1** | / | **Spion (Gefr)** | 1 Feld | Schwächste Einheit im Kampf – **besiegt jedoch den 4★ General**, wenn der Spion den Angriff initiiert! |
| **11** | 💣 | **Landmine / Bombe** | *Immobil* | Vernichtet jeden Angreifer sofort, außer den Pionier (Rang 3). |
| **0** | 🚩 | **Kommandoflagge** | *Immobil* | Das Hauptziel – wer die feindliche Flagge erobert, gewinnt sofort! |

---

## 🕹️ Steuerung & Bedienung

- **Mausklick Links**: Einheit auswählen, Ziel-Hexfeld anklicken oder per **Drag & Drop** in der Aufstellungsphase platzieren.
- **Mausklick Rechts + Ziehen**: 3D-Kamera frei um das Schlachtfeld rotieren / neigen.
- **Mausrad**: In das Spielfeld hinein- oder herauszoomen.
- **Kamera-HUD**: Schnellumschaltung zwischen Standard 3D-Ansicht, Draufsicht (`📐 Draufsicht`) und kinoreifer Nahansicht (`🎬 Nahansicht`).
- **Nebel-Schalter (`👁️ Nebel: AN/AUS`)**: Entwickler- und Testmodus zum Aufdecken der verdeckten KI-Einheiten.

---

## 🛠️ Technologie-Stack

- **Programmiersprache**: [TypeScript](https://www.typescriptlang.org/) (Strict Mode)
- **3D-Engine**: [Three.js](https://threejs.org/) (WebGL / PBR Shader / Raycasting / Partikel)
- **Build-Tool & Bundler**: [Vite](https://vitejs.dev/)
- **Threading**: Web Workers (`worker_threads` / Browser Web Workers) für unblockiertes Multithreading der KI-Suche
- **Audio**: Web Audio API (Synthetische Sound-Synthese ohne externe MP3-Assets)
- **Styling**: Modernes Responsive CSS (Dark Cyber/Military-Theme, Glassmorphism, Status-Badges)

---

## 🚀 Installation & Lokaler Start

### Voraussetzungen
- [Node.js](https://nodejs.org/) (Version 18+ empfohlen)
- `npm`, `yarn` oder `pnpm`

### Setup-Schritte

1. **Repository klonen oder Verzeichnis öffnen**:
   ```bash
   cd war
   ```

2. **Abhängigkeiten installieren**:
   ```bash
   npm install
   ```

3. **Entwicklungsserver starten**:
   ```bash
   npm run dev
   ```
   Die Anwendung läuft nun standardmäßig unter `http://localhost:5173/`.

4. **Produktions-Build erstellen**:
   ```bash
   npm run build
   ```

5. **Build-Vorschau starten**:
   ```bash
   npm run preview
   ```

---

## 📁 Projektstruktur

```
war/
├── index.html            # HTML-Einstiegspunkt
├── package.json          # Projektabhängigkeiten & Skripte
├── tsconfig.json         # TypeScript-Konfiguration
├── .gitignore            # Git-Ausschlussregeln
└── src/
    ├── main.ts           # UI-Initialisierung, DOM-Events & HUD
    ├── game.ts           # Hauptspiellogik, Züge, Phasen & Regelwerk
    ├── renderer.ts       # Three.js 3D-Szenengraph, Meshes, Beleuchtung & Partikel
    ├── hex.ts            # Axiale Hexagon-Mathematik (Pointy-Top, Distanzen, Richtungen)
    ├── insignia.ts       # Prozedurale SVG-Generierung der Bundeswehr-Dienstgrade
    ├── types.ts          # Datenmodelle, Einheiten-Definitionen & Schnittstellen
    ├── audio.ts          # Web Audio Synthesizer für Soundeffekte
    ├── ai.ts             # Minimax/Alpha-Beta, Heuristiken & Wahrscheinlichkeitsanalyse
    ├── ai-pool.ts        # Multi-Thread Web-Worker-Pool für die KI
    ├── ai.worker.ts      # Web-Worker-Thread für parallele Stellungsbewertungen
    └── style.css         # Styling, Layout & visuelle Komponenten
```

---

## 📜 Lizenz

Dieses Projekt steht unter privater/freier Nutzung für Bildungs- und Spielzwecke.
