import * as THREE from 'three';
import { AxialCoord, axialToPixel, coordKey, pixelToAxial } from './hex';
import { HexFrontlineGame } from './game';
import { HexTile, ORDERED_UNIT_TYPES, Unit, UNIT_DEFINITIONS, UnitType } from './types';
import { getInsigniaImage } from './insignia';

interface TileMeshData {
  key: string;
  tile: HexTile;
  group: THREE.Group;
  topMesh: THREE.Mesh;
  topMaterial: THREE.MeshStandardMaterial;
  rimLine: THREE.LineLoop;
  rimMaterial: THREE.LineBasicMaterial;
  waterMesh?: THREE.Mesh;
  baseY: number;
  currentY: number;
}

interface UnitMeshData {
  unitId: string;
  group: THREE.Group;
  pedestalMat: THREE.MeshStandardMaterial;
  pedestalRingMat: THREE.MeshBasicMaterial;
  faceMat: THREE.MeshStandardMaterial;
  topperGroup: THREE.Group;
  flagWaveMesh?: THREE.Mesh;
  bombLightMat?: THREE.MeshBasicMaterial;
  revealedRing: THREE.Mesh;
  selectRing: THREE.Mesh;
  lastTextureKey: string;
  lastTopperKey: string;
}

interface Particle3D {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  life: number;
  maxLife: number;
  initialScale: number;
}

export class HexRenderer {
  private canvas: HTMLCanvasElement;
  private game: HexFrontlineGame;

  // Three.js Core
  private webglRenderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // World scale: 1 hex size = 1.0 world unit
  private readonly worldHexSize = 1.0;

  // Camera spherical coordinates around target
  private camTarget = new THREE.Vector3(0, 0, 0.35);
  private camGoalTarget = new THREE.Vector3(0, 0, 0.35);
  private camTheta = 0; // Horizontal orbit angle (radians)
  private camPhi = 0.72; // Polar angle from Y-up (0 = top-down, PI/2 = horizon)
  private camRadius = 14.2;
  private camGoalTheta = 0;
  private camGoalPhi = 0.72;
  private camGoalRadius = 14.2;

  // Camera orbit interaction state
  private isOrbiting = false;
  private orbitStart = { x: 0, y: 0, theta: 0, phi: 0 };

  // Pointer & Drag-and-Drop State
  public hoveredHex: AxialCoord | null = null;
  private draggingUnit: Unit | null = null;
  private dragStartScreen: { x: number; y: number } | null = null;
  private dragCurrentWorld: { x: number; z: number } | null = null;
  private isDraggingActive = false;

  // Scene Groups & Caches
  private boardGroup = new THREE.Group();
  private highlightsGroup = new THREE.Group();
  private unitsGroup = new THREE.Group();
  private effectsGroup = new THREE.Group();

  private tileMeshes = new Map<string, TileMeshData>();
  private unitMeshes = new Map<string, UnitMeshData>();
  private ghostUnitGroup: THREE.Group | null = null;
  private lastBoardPhase = '';

  // Highlight Meshes Pool
  private moveHighlightMeshes: THREE.Object3D[] = [];
  private lastMoveGroup = new THREE.Group();

  // Texture Cache for Unit Faces
  private faceTextureCache = new Map<string, THREE.CanvasTexture>();

  // Combat & Particle Effects
  private particles: Particle3D[] = [];
  private shockwaveRing: THREE.Mesh | null = null;
  private shockwaveProgress = 0;
  private combatLight: THREE.PointLight;
  private lastCombatTimestamp = 0;
  private cameraShakeAmount = 0;

  // Animation loop
  private clock = new THREE.Clock();

  constructor(canvas: HTMLCanvasElement, game: HexFrontlineGame) {
    this.canvas = canvas;
    this.game = game;

    // 1. Initialize WebGLRenderer
    this.webglRenderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.webglRenderer.shadowMap.enabled = true;
    this.webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webglRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.webglRenderer.toneMappingExposure = 1.12;

    // 2. Initialize 3D Scene & Fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070c17');
    this.scene.fog = new THREE.FogExp2('#070c17', 0.022);

    // 3. Initialize Camera
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 100);
    this.updateCameraTransform();

    // 4. Setup Lighting
    this.setupLights();
    this.combatLight = new THREE.PointLight(0xf59e0b, 0, 8);
    this.combatLight.position.set(0, 2.5, 0);
    this.scene.add(this.combatLight);

    // 5. Add Groups
    this.scene.add(this.boardGroup);
    this.scene.add(this.highlightsGroup);
    this.scene.add(this.lastMoveGroup);
    this.scene.add(this.unitsGroup);
    this.scene.add(this.effectsGroup);

    // 6. Build War-Room Pedestal & Initial Board
    this.buildWarTableEnvironment();
    this.rebuildBoardTiles();

    // 7. Preload Bundeswehr SVG insignia images & refresh unit textures when ready
    for (const type of ORDERED_UNIT_TYPES) {
      getInsigniaImage(type, () => {
        this.invalidateUnitFaceTextures(type);
        this.syncSceneWithGame();
      });
    }

    // 8. Setup Events & Resize
    this.setupEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // 9. Start continuous 60fps WebGL loop
    this.animate();
  }

  private setupLights(): void {
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.85);
    hemiLight.position.set(0, 20, 0);
    this.scene.add(hemiLight);

    const mainDirLight = new THREE.DirectionalLight(0xfffbeb, 1.65);
    mainDirLight.position.set(8, 16, 10);
    mainDirLight.castShadow = true;
    mainDirLight.shadow.mapSize.width = 2048;
    mainDirLight.shadow.mapSize.height = 2048;
    mainDirLight.shadow.camera.near = 2;
    mainDirLight.shadow.camera.far = 38;
    const d = 9.5;
    mainDirLight.shadow.camera.left = -d;
    mainDirLight.shadow.camera.right = d;
    mainDirLight.shadow.camera.top = d;
    mainDirLight.shadow.camera.bottom = -d;
    mainDirLight.shadow.bias = -0.0005;
    this.scene.add(mainDirLight);

    // Cool tactical rim light from north-west
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
    rimLight.position.set(-10, 9, -10);
    this.scene.add(rimLight);

    // Warm bounce light from south
    const frontFill = new THREE.DirectionalLight(0x93c5fd, 0.35);
    frontFill.position.set(0, 6, 12);
    this.scene.add(frontFill);
  }

  private buildWarTableEnvironment(): void {
    // Dark tactical war-table platform under the hex grid
    const tableGeo = new THREE.CylinderGeometry(8.9, 9.5, 0.6, 6);
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.7,
      metalness: 0.35
    });
    const tableMesh = new THREE.Mesh(tableGeo, tableMat);
    tableMesh.position.y = -0.46;
    tableMesh.receiveShadow = true;
    this.scene.add(tableMesh);

    // Glowing outer tactical ring
    const ringGeo = new THREE.RingGeometry(8.75, 8.88, 6, 1);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.rotateY(Math.PI / 6);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.y = -0.15;
    this.scene.add(ringMesh);

    // Subtle radar grid floor beneath the table
    const gridHelper = new THREE.GridHelper(36, 36, 0x1e3a8a, 0x0f172a);
    gridHelper.position.y = -0.78;
    this.scene.add(gridHelper);
  }

  public setCameraPreset(preset: 'perspective' | 'topdown' | 'cinematic'): void {
    this.camGoalTarget.set(0, 0, 0.35);
    if (preset === 'topdown') {
      this.camGoalTheta = 0;
      this.camGoalPhi = 0.12; // Almost straight down
      this.camGoalRadius = 15.2;
    } else if (preset === 'cinematic') {
      this.camGoalTheta = 0.42;
      this.camGoalPhi = 0.92; // Low dramatic angle
      this.camGoalRadius = 13.0;
    } else {
      // Standard ergonomic 3D commander view
      this.camGoalTheta = 0;
      this.camGoalPhi = 0.72;
      this.camGoalRadius = 14.2;
    }
  }

  public resetCamera(): void {
    this.setCameraPreset('perspective');
  }

  public zoomCamera(delta: number): void {
    this.camGoalRadius = Math.max(7.5, Math.min(22.0, this.camGoalRadius + delta));
  }

  public resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    this.webglRenderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    // Adjust vertical FOV slightly on narrower screens so the whole hex board fits comfortably
    const aspect = width / height;
    this.camera.fov = aspect < 1.1 ? 48 : 40;
    this.camera.updateProjectionMatrix();
  }

  public render(): void {
    // Called by game state changes; synchronize 3D scene immediately
    this.syncSceneWithGame();
  }

  // ============================================================================
  // 3D HEX BOARD CONSTRUCTION
  // ============================================================================
  private rebuildBoardTiles(): void {
    while (this.boardGroup.children.length > 0) {
      this.boardGroup.remove(this.boardGroup.children[0]);
    }
    this.tileMeshes.clear();

    const hexRadius = this.worldHexSize * 0.96;

    for (const tile of this.game.tiles.values()) {
      const key = coordKey(tile.q, tile.r);
      const { x, y } = axialToPixel(tile.q, tile.r, this.worldHexSize);
      const group = new THREE.Group();
      group.position.set(x, 0, y);

      let tileHeight = 0.26;
      let baseY = 0;
      let topColor = 0x1e293b;
      let sideColor = 0x0f172a;
      let roughness = 0.65;

      if (tile.terrain === 'grass') {
        tileHeight = 0.26;
        topColor = (tile.q + tile.r) % 2 === 0 ? 0x1e293b : 0x26354d;
      } else if (tile.terrain === 'forest') {
        tileHeight = 0.30;
        topColor = 0x143829;
        sideColor = 0x0d261c;
      } else if (tile.terrain === 'water') {
        tileHeight = 0.14;
        baseY = -0.07;
        topColor = 0x082f49;
        sideColor = 0x071f33;
        roughness = 0.3;
      } else if (tile.terrain === 'mountain') {
        tileHeight = 0.38;
        baseY = 0.05;
        topColor = 0x334155;
        sideColor = 0x1e293b;
        roughness = 0.85;
      }

      group.position.y = baseY;

      // Base lower skirt
      const skirtGeo = new THREE.CylinderGeometry(hexRadius, hexRadius * 0.94, tileHeight, 6);
      const skirtMat = new THREE.MeshStandardMaterial({
        color: sideColor,
        roughness: 0.8,
        metalness: 0.2
      });
      const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
      skirtMesh.position.y = -tileHeight / 2;
      skirtMesh.receiveShadow = true;
      skirtMesh.castShadow = true;
      skirtMesh.userData = { axial: { q: tile.q, r: tile.r } };
      group.add(skirtMesh);

      // Top beveled cap
      const capHeight = 0.05;
      const capGeo = new THREE.CylinderGeometry(hexRadius * 0.93, hexRadius * 0.98, capHeight, 6);
      const topMaterial = new THREE.MeshStandardMaterial({
        color: topColor,
        roughness,
        metalness: 0.15
      });
      const topMesh = new THREE.Mesh(capGeo, topMaterial);
      topMesh.position.y = capHeight / 2;
      topMesh.receiveShadow = true;
      topMesh.castShadow = tile.terrain === 'mountain';
      topMesh.userData = { axial: { q: tile.q, r: tile.r } };
      group.add(topMesh);

      // Crisp hexagonal wire rim on top
      const rimGeo = this.createHexLineGeometry(hexRadius * 0.935);
      const rimMaterial = new THREE.LineBasicMaterial({
        color: 0x475569,
        transparent: true,
        opacity: 0.75
      });
      const rimLine = new THREE.LineLoop(rimGeo, rimMaterial);
      rimLine.position.y = capHeight + 0.004;
      group.add(rimLine);

      // Add 3D Terrain Scenery (Forests, Mountains, Water)
      let waterMesh: THREE.Mesh | undefined;
      if (tile.terrain === 'forest') {
        this.addForestScenery(group, capHeight);
      } else if (tile.terrain === 'mountain') {
        this.addMountainScenery(group, capHeight);
      } else if (tile.terrain === 'water') {
        waterMesh = this.addWaterScenery(group, hexRadius * 0.91, capHeight);
      }

      this.boardGroup.add(group);
      this.tileMeshes.set(key, {
        key,
        tile,
        group,
        topMesh,
        topMaterial,
        rimLine,
        rimMaterial,
        waterMesh,
        baseY,
        currentY: baseY
      });
    }
  }

  private addForestScenery(group: THREE.Group, surfaceY: number): void {
    // Place 4 stylized 3D pine trees near the outer corners of the hex so the center stays clear for units!
    const treeOffsets = [
      { x: -0.52, z: -0.32, scale: 0.85 },
      { x: 0.54, z: -0.28, scale: 0.95 },
      { x: -0.48, z: 0.36, scale: 0.78 },
      { x: 0.50, z: 0.34, scale: 0.88 }
    ];

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });
    const leavesMat1 = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.75, flatShading: true });
    const leavesMat2 = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.75, flatShading: true });

    for (const pos of treeOffsets) {
      const tree = new THREE.Group();
      tree.position.set(pos.x, surfaceY, pos.z);
      tree.scale.setScalar(pos.scale);

      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5), trunkMat);
      trunk.position.y = 0.08;
      trunk.castShadow = true;
      tree.add(trunk);

      const cone1 = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.28, 6), leavesMat2);
      cone1.position.y = 0.24;
      cone1.castShadow = true;
      cone1.receiveShadow = true;
      tree.add(cone1);

      const cone2 = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.24, 6), leavesMat1);
      cone2.position.y = 0.38;
      cone2.castShadow = true;
      tree.add(cone2);

      const cone3 = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 6), leavesMat1);
      cone3.position.y = 0.50;
      cone3.castShadow = true;
      tree.add(cone3);

      group.add(tree);
    }
  }

  private addMountainScenery(group: THREE.Group, surfaceY: number): void {
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.85,
      metalness: 0.1,
      flatShading: true
    });
    const snowMat = new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.4,
      flatShading: true
    });

    const peaks = [
      { x: 0.0, z: -0.05, r: 0.54, h: 1.05, rot: 0.2 },
      { x: -0.34, z: 0.22, r: 0.38, h: 0.72, rot: 1.1 },
      { x: 0.34, z: 0.18, r: 0.35, h: 0.65, rot: 2.4 }
    ];

    for (const p of peaks) {
      const peakGroup = new THREE.Group();
      peakGroup.position.set(p.x, surfaceY, p.z);
      peakGroup.rotation.y = p.rot;

      const rock = new THREE.Mesh(new THREE.ConeGeometry(p.r, p.h, 5), rockMat);
      rock.position.y = p.h / 2;
      rock.castShadow = true;
      rock.receiveShadow = true;
      peakGroup.add(rock);

      // Snow cap on top 38% of peak
      const snowH = p.h * 0.38;
      const snowR = p.r * 0.39;
      const snow = new THREE.Mesh(new THREE.ConeGeometry(snowR, snowH, 5), snowMat);
      snow.position.y = p.h - snowH / 2 + 0.005;
      snow.castShadow = true;
      peakGroup.add(snow);

      group.add(peakGroup);
    }
  }

  private addWaterScenery(group: THREE.Group, radius: number, surfaceY: number): THREE.Mesh {
    const waterGeo = new THREE.CylinderGeometry(radius, radius, 0.08, 6);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x0369a1,
      emissiveIntensity: 0.25,
      roughness: 0.15,
      metalness: 0.5,
      transparent: true,
      opacity: 0.86
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = surfaceY + 0.04;
    waterMesh.receiveShadow = true;
    group.add(waterMesh);

    // Inner ripple ring
    const rippleGeo = this.createHexLineGeometry(radius * 0.55);
    const rippleMat = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.45
    });
    const ripple = new THREE.LineLoop(rippleGeo, rippleMat);
    ripple.position.y = 0.045;
    waterMesh.add(ripple);

    return waterMesh;
  }

  private createHexLineGeometry(radius: number): THREE.BufferGeometry {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = ((60 * i - 30) * Math.PI) / 180;
      pts.push(new THREE.Vector3(radius * Math.cos(angle), 0, radius * Math.sin(angle)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ============================================================================
  // SCENE SYNCHRONIZATION WITH GAME STATE
  // ============================================================================
  private syncSceneWithGame(): void {
    // Check if board tiles map was regenerated
    if (this.tileMeshes.size !== this.game.tiles.size) {
      this.rebuildBoardTiles();
    }

    // 1. Determine valid move & attack sets
    const validMovesSet = new Set<string>();
    const attackMovesSet = new Set<string>();

    const activeUnitId =
      this.isDraggingActive && this.draggingUnit ? this.draggingUnit.id : this.game.selectedUnitId;

    if (
      (this.game.phase === 'player_turn' ||
        (this.game.phase === 'setup' && this.game.isPlayerSetupComplete())) &&
      activeUnitId
    ) {
      const selectedUnit = this.game.units.find(u => u.id === activeUnitId);
      if (selectedUnit) {
        const moves = this.game.getValidMoves(selectedUnit);
        for (const m of moves) {
          const occupant = this.game.getUnitAt(m.q, m.r);
          if (occupant && occupant.faction !== selectedUnit.faction) {
            attackMovesSet.add(coordKey(m.q, m.r));
          } else {
            validMovesSet.add(coordKey(m.q, m.r));
          }
        }
      }
    }

    // 2. Update Tile Materials & Highlights
    this.updateTileMaterialsAndHighlights(validMovesSet, attackMovesSet);

    // 3. Update Last Move 3D Arc Indicator
    this.updateLastMove3D();

    // 4. Synchronize 3D Units
    this.syncUnits3D();

    // 5. Trigger 3D Combat Explosion if a new combat event occurred
    if (this.game.activeCombat && this.game.activeCombat.timestamp !== this.lastCombatTimestamp) {
      this.lastCombatTimestamp = this.game.activeCombat.timestamp;
      this.spawnCombatExplosion(this.game.activeCombat.toQ, this.game.activeCombat.toR, this.game.activeCombat.defender.type === 'bomb');
    }
  }

  private updateTileMaterialsAndHighlights(
    validMoves: Set<string>,
    attackMoves: Set<string>
  ): void {
    // Clear previous dynamic move highlight markers
    while (this.highlightsGroup.children.length > 0) {
      this.highlightsGroup.remove(this.highlightsGroup.children[0]);
    }
    this.moveHighlightMeshes = [];

    for (const [key, data] of this.tileMeshes.entries()) {
      const { tile, topMaterial, rimMaterial } = data;
      const isHovered =
        this.hoveredHex !== null && this.hoveredHex.q === tile.q && this.hoveredHex.r === tile.r;

      let topHex = 0x1e293b;
      let rimHex = 0x475569;
      let emissiveHex = 0x000000;
      let emissiveIntensity = 0;

      if (tile.terrain === 'grass') {
        if (this.game.phase === 'setup') {
          if (tile.r >= 2) {
            topHex = 0x172554;
            rimHex = 0x3b82f6;
          } else if (tile.r <= -2) {
            topHex = 0x3b1219;
            rimHex = 0x991b1b;
          } else {
            topHex = (tile.q + tile.r) % 2 === 0 ? 0x1e293b : 0x243247;
          }
        } else {
          topHex = (tile.q + tile.r) % 2 === 0 ? 0x1e293b : 0x243247;
        }
      } else if (tile.terrain === 'forest') {
        topHex = 0x143829;
        rimHex = 0x22543d;
      } else if (tile.terrain === 'water') {
        topHex = 0x082f49;
        rimHex = 0x0284c7;
      } else if (tile.terrain === 'mountain') {
        topHex = 0x334155;
        rimHex = 0x64748b;
      }

      if (isHovered && tile.terrain !== 'water' && tile.terrain !== 'mountain') {
        emissiveHex = 0x38bdf8;
        emissiveIntensity = 0.22;
        rimHex = 0x93c5fd;
      }

      // Valid move green 3D beacon
      if (validMoves.has(key)) {
        emissiveHex = 0x22c55e;
        emissiveIntensity = isHovered ? 0.55 : 0.28;
        rimHex = 0x4ade80;

        const marker = this.createMoveMarker(data.group.position.x, data.group.position.z, false, isHovered);
        this.highlightsGroup.add(marker);
        this.moveHighlightMeshes.push(marker);
      } else if (attackMoves.has(key)) {
        emissiveHex = 0xef4444;
        emissiveIntensity = isHovered ? 0.65 : 0.38;
        rimHex = 0xf87171;

        const marker = this.createMoveMarker(data.group.position.x, data.group.position.z, true, isHovered);
        this.highlightsGroup.add(marker);
        this.moveHighlightMeshes.push(marker);
      } else if (
        this.isDraggingActive &&
        this.game.phase === 'setup' &&
        isHovered &&
        this.game.isDeploymentTile('player', tile.q, tile.r)
      ) {
        emissiveHex = 0xfacc15;
        emissiveIntensity = 0.45;
        rimHex = 0xfde047;
      }

      topMaterial.color.setHex(topHex);
      topMaterial.emissive.setHex(emissiveHex);
      topMaterial.emissiveIntensity = emissiveIntensity;
      rimMaterial.color.setHex(rimHex);
    }
  }

  private createMoveMarker(x: number, z: number, isAttack: boolean, isHovered: boolean): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0.08, z);

    const color = isAttack ? 0xef4444 : 0x22c55e;
    const ringGeo = new THREE.RingGeometry(
      isAttack ? 0.62 : 0.22,
      isAttack ? 0.78 : 0.36,
      isAttack ? 6 : 24
    );
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isHovered ? 0.95 : 0.75,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    g.add(ring);

    if (!isAttack) {
      const dotGeo = new THREE.SphereGeometry(0.11, 12, 12);
      const dotMat = new THREE.MeshBasicMaterial({ color: 0x86efac });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.y = 0.06;
      g.add(dot);
    }

    return g;
  }

  private updateLastMove3D(): void {
    while (this.lastMoveGroup.children.length > 0) {
      this.lastMoveGroup.remove(this.lastMoveGroup.children[0]);
    }
    if (!this.game.lastMove) return;

    const { fromQ, fromR, toQ, toR } = this.game.lastMove;
    const from = axialToPixel(fromQ, fromR, this.worldHexSize);
    const to = axialToPixel(toQ, toR, this.worldHexSize);

    // Golden origin hex outline
    const originOutline = new THREE.LineLoop(
      this.createHexLineGeometry(this.worldHexSize * 0.82),
      new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.65 })
    );
    originOutline.position.set(from.x, 0.08, from.y);
    this.lastMoveGroup.add(originOutline);

    // 3D curved trajectory arc from origin to destination
    const startVec = new THREE.Vector3(from.x, 0.1, from.y);
    const endVec = new THREE.Vector3(to.x, 0.1, to.y);
    const midVec = new THREE.Vector3().lerpVectors(startVec, endVec, 0.5);
    midVec.y = 0.55;

    const curve = new THREE.QuadraticBezierCurve3(startVec, midVec, endVec);
    const tubeGeo = new THREE.TubeGeometry(curve, 20, 0.032, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.55
    });
    const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
    this.lastMoveGroup.add(tubeMesh);
  }

  // ============================================================================
  // 3D STRATEG0 UNITS & DYNAMIC INSIGNIA TEXTURES
  // ============================================================================
  private syncUnits3D(): void {
    const aliveIds = new Set<string>();

    for (const unit of this.game.units) {
      aliveIds.add(unit.id);
      let meshData = this.unitMeshes.get(unit.id);
      if (!meshData) {
        meshData = this.createUnitMeshData(unit);
        this.unitMeshes.set(unit.id, meshData);
        this.unitsGroup.add(meshData.group);
      }
      this.updateUnitAppearance(unit, meshData);
    }

    // Remove dead units
    for (const [id, meshData] of this.unitMeshes.entries()) {
      if (!aliveIds.has(id)) {
        this.unitsGroup.remove(meshData.group);
        this.unitMeshes.delete(id);
      }
    }
  }

  private createUnitMeshData(unit: Unit): UnitMeshData {
    const group = new THREE.Group();
    const isPlayer = unit.faction === 'player';

    // 1. Selection Glow Ring on Ground
    const selectGeo = new THREE.RingGeometry(0.60, 0.74, 32);
    selectGeo.rotateX(-Math.PI / 2);
    const selectMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      side: THREE.DoubleSide
    });
    const selectRing = new THREE.Mesh(selectGeo, selectMat);
    selectRing.position.y = 0.02;
    selectRing.visible = false;
    group.add(selectRing);

    // 2. Metallic Tactical Pedestal Base
    const baseOuterGeo = new THREE.CylinderGeometry(0.54, 0.60, 0.14, 24);
    const baseOuterMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.75
    });
    const baseOuter = new THREE.Mesh(baseOuterGeo, baseOuterMat);
    baseOuter.position.y = 0.07;
    baseOuter.castShadow = true;
    baseOuter.receiveShadow = true;
    group.add(baseOuter);

    const pedestalGeo = new THREE.CylinderGeometry(0.46, 0.51, 0.10, 24);
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: isPlayer ? 0x1d4ed8 : 0xb91c1c,
      roughness: 0.35,
      metalness: 0.35
    });
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.y = 0.16;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    // Glowing team accent ring around pedestal
    const pedRingGeo = new THREE.RingGeometry(0.47, 0.52, 24);
    pedRingGeo.rotateX(-Math.PI / 2);
    const pedestalRingMat = new THREE.MeshBasicMaterial({
      color: isPlayer ? 0x60a5fa : 0xf87171,
      side: THREE.DoubleSide
    });
    const pedRing = new THREE.Mesh(pedRingGeo, pedestalRingMat);
    pedRing.position.y = 0.145;
    group.add(pedRing);

    // 3. Sculpted 3D Frontline Command Monolith / Shield Stand
    // Angled display body so insignia is readable from both 3D perspective AND top-down!
    const standGroup = new THREE.Group();
    standGroup.position.y = 0.21;
    group.add(standGroup);

    const bodyGeo = new THREE.BoxGeometry(0.68, 0.76, 0.24);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: isPlayer ? 0x1e3a8a : 0x7f1d1d,
      roughness: 0.45,
      metalness: 0.4
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.set(0, 0.32, -0.02);
    // Tilt backward by ~34 degrees so it faces up and toward the player camera
    bodyMesh.rotation.x = -0.58;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    standGroup.add(bodyMesh);

    // Front Display Plate with Dynamic Bundeswehr Rank Insignia Texture
    const faceGeo = new THREE.PlaneGeometry(0.62, 0.70);
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0.1
    });
    const faceMesh = new THREE.Mesh(faceGeo, faceMat);
    faceMesh.position.set(0, 0, 0.125);
    bodyMesh.add(faceMesh);

    // 4. 3D Role-Specific Topper Group (Flagpole, Mine spikes, General stars, etc.)
    const topperGroup = new THREE.Group();
    topperGroup.position.set(0, 0.21, 0);
    group.add(topperGroup);

    // 5. Floating "Revealed to Enemy" Golden Halo Ring
    const revGeo = new THREE.RingGeometry(0.32, 0.39, 6);
    revGeo.rotateX(-Math.PI / 2);
    const revMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide
    });
    const revealedRing = new THREE.Mesh(revGeo, revMat);
    revealedRing.position.y = 1.05;
    revealedRing.visible = false;
    group.add(revealedRing);

    return {
      unitId: unit.id,
      group,
      pedestalMat,
      pedestalRingMat,
      faceMat,
      topperGroup,
      revealedRing,
      selectRing,
      lastTextureKey: '',
      lastTopperKey: ''
    };
  }

  private updateUnitAppearance(unit: Unit, data: UnitMeshData): void {
    const isPlayer = unit.faction === 'player';
    const showIdentity =
      isPlayer || unit.revealed || this.game.debugRevealAI || this.game.phase === 'game_over';
    const isSelected = this.game.selectedUnitId === unit.id;

    data.selectRing.visible = isSelected;
    data.revealedRing.visible = unit.revealed && this.game.phase !== 'game_over';

    const xpVal = showIdentity && this.game.gameMode === 'scouts_only' ? (unit.xp ?? 0) : 0;
    const texKey = `${unit.faction}_${showIdentity ? unit.type : 'hidden'}_${unit.revealed ? 'rev' : 'hid'}_xp${xpVal}`;
    if (data.lastTextureKey !== texKey) {
      data.lastTextureKey = texKey;
      data.faceMat.map = this.getOrCreateUnitFaceTexture(
        unit.faction,
        showIdentity ? unit.type : null,
        unit.revealed,
        xpVal
      );
      data.faceMat.needsUpdate = true;
    }

    const topperKey = showIdentity ? unit.type : 'hidden';
    if (data.lastTopperKey !== topperKey) {
      data.lastTopperKey = topperKey;
      this.rebuildUnitTopper(data, unit.faction, showIdentity ? unit.type : null);
    }
  }

  private rebuildUnitTopper(
    data: UnitMeshData,
    faction: 'player' | 'ai',
    visibleType: UnitType | null
  ): void {
    while (data.topperGroup.children.length > 0) {
      data.topperGroup.remove(data.topperGroup.children[0]);
    }
    data.flagWaveMesh = undefined;
    data.bombLightMat = undefined;

    if (!visibleType) return;

    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      roughness: 0.25,
      metalness: 0.85
    });
    const silverMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.3,
      metalness: 0.8
    });

    if (visibleType === 'flag') {
      // 3D Flagpole rising behind the shield with a waving German flag!
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.032, 1.05, 8),
        silverMat
      );
      pole.position.set(-0.22, 0.52, -0.18);
      pole.castShadow = true;
      data.topperGroup.add(pole);

      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), goldMat);
      finial.position.set(-0.22, 1.06, -0.18);
      data.topperGroup.add(finial);

      const flagGeo = new THREE.PlaneGeometry(0.55, 0.34, 8, 1);
      const flagTex = this.createFlagBannerTexture(faction);
      const flagMat = new THREE.MeshStandardMaterial({
        map: flagTex,
        side: THREE.DoubleSide,
        roughness: 0.5
      });
      const flagMesh = new THREE.Mesh(flagGeo, flagMat);
      flagMesh.position.set(0.06, 0.86, -0.18);
      flagMesh.castShadow = true;
      data.topperGroup.add(flagMesh);
      data.flagWaveMesh = flagMesh;
    } else if (visibleType === 'bomb') {
      // 3D Naval/Landmine Sphere with detonator horns and pulsing red beacon
      const mineGroup = new THREE.Group();
      mineGroup.position.set(0, 0.68, -0.22);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.20, 14, 14),
        new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.7 })
      );
      sphere.castShadow = true;
      mineGroup.add(sphere);

      const lightMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 10), lightMat);
      beacon.position.y = 0.18;
      mineGroup.add(beacon);
      data.bombLightMat = lightMat;

      // Spikes / horns
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3;
        const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.035, 0.14, 6), silverMat);
        horn.position.set(Math.cos(angle) * 0.16, 0.06, Math.sin(angle) * 0.16);
        horn.rotation.z = -Math.cos(angle) * 0.8;
        horn.rotation.x = Math.sin(angle) * 0.8;
        mineGroup.add(horn);
      }

      data.topperGroup.add(mineGroup);
    } else if (visibleType === 'marshal' || visibleType === 'general') {
      // Golden Command Crest on top of the angled block
      const starsCount = visibleType === 'marshal' ? 4 : 3;
      const startX = -((starsCount - 1) * 0.14) / 2;
      for (let i = 0; i < starsCount; i++) {
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.065, 0), goldMat);
        star.position.set(startX + i * 0.14, 0.68, -0.22);
        star.castShadow = true;
        data.topperGroup.add(star);
      }
    } else if (visibleType === 'colonel' || visibleType === 'major') {
      const crest = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 0), silverMat);
      crest.position.set(0, 0.68, -0.22);
      data.topperGroup.add(crest);
    }
  }

  private createFlagBannerTexture(faction: 'player' | 'ai'): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 80;
    const ctx = c.getContext('2d')!;
    // German tricolor with team emblem border
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, 128, 27);
    ctx.fillStyle = '#dc2626';
    ctx.fillRect(0, 27, 128, 26);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(0, 53, 128, 27);

    ctx.strokeStyle = faction === 'player' ? '#60a5fa' : '#f87171';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 122, 74);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private invalidateUnitFaceTextures(type: UnitType): void {
    for (const key of Array.from(this.faceTextureCache.keys())) {
      if (key.includes(`_${type}_`)) {
        this.faceTextureCache.delete(key);
      }
    }
    for (const meshData of this.unitMeshes.values()) {
      if (meshData.lastTextureKey.includes(`_${type}_`)) {
        meshData.lastTextureKey = '';
      }
    }
  }

  private getOrCreateUnitFaceTexture(
    faction: 'player' | 'ai',
    visibleType: UnitType | null,
    isRevealed: boolean,
    xp = 0
  ): THREE.CanvasTexture {
    const cacheKey = `${faction}_${visibleType ?? 'hidden'}_${isRevealed ? 'rev' : 'hid'}_xp${xp}`;
    const existing = this.faceTextureCache.get(cacheKey);
    if (existing) return existing;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 288;
    const ctx = canvas.getContext('2d')!;

    const isPlayer = faction === 'player';

    // 1. Tactical Card Background Gradient
    const grad = ctx.createLinearGradient(0, 0, 0, 288);
    if (isPlayer) {
      grad.addColorStop(0, '#1e40af');
      grad.addColorStop(0.5, '#1d4ed8');
      grad.addColorStop(1, '#0f172a');
    } else {
      grad.addColorStop(0, '#991b1b');
      grad.addColorStop(0.5, '#7f1d1d');
      grad.addColorStop(1, '#0f172a');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 288);

    // 2. Metallic Outer Frame
    ctx.strokeStyle = isPlayer ? '#93c5fd' : '#fca5a5';
    ctx.lineWidth = 10;
    ctx.strokeRect(6, 6, 244, 276);

    if (visibleType) {
      const def = UNIT_DEFINITIONS[visibleType];

      // Draw Bundeswehr Shoulder Board (Schulterklappe) SVG Image in center-top
      const img = getInsigniaImage(visibleType);
      if (img.complete && img.naturalWidth > 0) {
        const w = 136;
        const h = w * (56 / 40);
        ctx.drawImage(img, (256 - w) / 2, 16, w, h);
      }

      // Bottom Rank & ShortName Banner
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.beginPath();
      ctx.roundRect(18, 212, 220, 58, 12);
      ctx.fill();
      ctx.strokeStyle = def.rank >= 9 ? '#fbbf24' : isPlayer ? '#60a5fa' : '#f87171';
      ctx.lineWidth = 4;
      ctx.stroke();

      const rankLabel =
        visibleType === 'flag'
          ? 'FLAGGE'
          : visibleType === 'bomb'
          ? 'MINE'
          : visibleType === 'spy'
          ? '1 • SPION'
          : `RANG ${def.rank} • ${def.shortName}`;

      ctx.font = 'bold 26px "Inter", system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rankLabel, 128, 242);

      // Experience progress badge on top-left corner when unit has 1/2 XP toward promotion
      if (xp > 0 && visibleType !== 'flag' && visibleType !== 'bomb' && visibleType !== 'marshal') {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(38, 38, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText('⬆1', 38, 39);
      }

      // Revealed eye indicator badge on top-right corner
      if (isRevealed) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(218, 38, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText('👁', 218, 39);
      }
    } else {
      // Hidden Enemy Frontline Shield ("?")
      ctx.strokeStyle = 'rgba(252, 165, 165, 0.35)';
      ctx.lineWidth = 4;
      ctx.strokeRect(24, 24, 208, 240);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.beginPath();
      ctx.arc(128, 132, 68, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fca5a5';
      ctx.lineWidth = 5;
      ctx.stroke();

      ctx.font = 'bold 96px "Inter", system-ui, sans-serif';
      ctx.fillStyle = '#fecaca';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 128, 138);

      ctx.font = 'bold 20px "Inter", system-ui, sans-serif';
      ctx.fillStyle = '#fca5a5';
      ctx.fillText('VERDECKT', 128, 236);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.faceTextureCache.set(cacheKey, texture);
    return texture;
  }

  // ============================================================================
  // 3D COMBAT EXPLOSION & SHOCKWAVE PARTICLES
  // ============================================================================
  private spawnCombatExplosion(q: number, r: number, isBomb: boolean): void {
    const pos = axialToPixel(q, r, this.worldHexSize);
    const cx = pos.x;
    const cz = pos.y;

    this.combatLight.position.set(cx, 2.2, cz);
    this.combatLight.color.setHex(isBomb ? 0xef4444 : 0xf59e0b);
    this.combatLight.intensity = isBomb ? 8.0 : 5.0;
    this.cameraShakeAmount = isBomb ? 0.25 : 0.12;

    // 1. Expanding Shockwave Ring
    if (!this.shockwaveRing) {
      const ringGeo = new THREE.RingGeometry(0.2, 0.42, 32);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide
      });
      this.shockwaveRing = new THREE.Mesh(ringGeo, ringMat);
      this.effectsGroup.add(this.shockwaveRing);
    }
    this.shockwaveRing.position.set(cx, 0.14, cz);
    this.shockwaveRing.scale.setScalar(0.5);
    this.shockwaveRing.visible = true;
    (this.shockwaveRing.material as THREE.MeshBasicMaterial).color.setHex(isBomb ? 0xef4444 : 0xfbbf24);
    this.shockwaveProgress = 0.001;

    // 2. Burst of 3D Sparks / Debris Cubes
    const count = isBomb ? 42 : 26;
    const colors = isBomb ? [0xef4444, 0xf97316, 0xfacc15, 0x475569] : [0xfbbf24, 0x60a5fa, 0xf87171, 0xffffff];

    for (let i = 0; i < count; i++) {
      const size = 0.06 + Math.random() * 0.08;
      const geo = new THREE.OctahedronGeometry(size, 0);
      const mat = new THREE.MeshBasicMaterial({
        color: colors[Math.floor(Math.random() * colors.length)]
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, 0.35 + Math.random() * 0.2, cz);

      const angle = Math.random() * Math.PI * 2;
      const speed = (isBomb ? 2.8 : 1.9) * (0.4 + Math.random() * 0.8);
      const vel = new THREE.Vector3(
        Math.cos(angle) * speed,
        2.2 + Math.random() * (isBomb ? 3.2 : 2.0),
        Math.sin(angle) * speed
      );
      const rotVel = new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      );

      this.effectsGroup.add(mesh);
      this.particles.push({
        mesh,
        vel,
        rotVel,
        life: 0,
        maxLife: 0.55 + Math.random() * 0.45,
        initialScale: 1
      });
    }
  }

  // ============================================================================
  // REAL-TIME 60FPS WEBGL RENDER LOOP
  // ============================================================================
  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const dt = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.getElapsedTime();

    if (this.lastBoardPhase !== this.game.phase) {
      this.lastBoardPhase = this.game.phase;
      this.syncSceneWithGame();
    }

    // 1. Smoothly interpolate 3D Camera Orbit & Zoom
    const lerpFactor = 1 - Math.exp(-10 * dt);
    this.camTheta += (this.camGoalTheta - this.camTheta) * lerpFactor;
    this.camPhi += (this.camGoalPhi - this.camPhi) * lerpFactor;
    this.camRadius += (this.camGoalRadius - this.camRadius) * lerpFactor;
    this.camTarget.lerp(this.camGoalTarget, lerpFactor);
    this.updateCameraTransform();

    // 2. Animate Water Tiles & Hover Tile Elevation
    for (const data of this.tileMeshes.values()) {
      const isHovered =
        this.hoveredHex !== null &&
        this.hoveredHex.q === data.tile.q &&
        this.hoveredHex.r === data.tile.r &&
        data.tile.terrain !== 'water' &&
        data.tile.terrain !== 'mountain';

      const targetY = data.baseY + (isHovered ? 0.065 : 0);
      data.currentY += (targetY - data.currentY) * (1 - Math.exp(-14 * dt));
      data.group.position.y = data.currentY;

      if (data.waterMesh) {
        const wave = Math.sin(elapsed * 2.6 + data.tile.q * 1.3 + data.tile.r * 0.9) * 0.018;
        data.waterMesh.position.y = 0.08 + wave;
      }
    }

    // 3. Pulse Valid Move / Attack Highlight Rings
    const pulse = 1 + Math.sin(elapsed * 5.0) * 0.08;
    for (const marker of this.moveHighlightMeshes) {
      marker.scale.set(pulse, 1, pulse);
    }

    // 4. Update Unit Positions, Parabolic Move Animations & Idle Topper Animations
    const anim = this.game.activeMoveAnim;
    let animProgress = 1;
    if (anim) {
      const now = performance.now();
      const rawT = Math.min(1, Math.max(0, (now - anim.startTime) / anim.duration));
      animProgress = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;
      if (rawT >= 1 && this.game.phase !== 'animating_move') {
        this.game.activeMoveAnim = null;
      }
    }

    for (const unit of this.game.units) {
      const meshData = this.unitMeshes.get(unit.id);
      if (!meshData) continue;

      const tileData = this.tileMeshes.get(coordKey(unit.q, unit.r));
      const surfaceY = (tileData ? tileData.currentY : 0) + 0.05;

      // Animate waving flag or pulsing bomb light
      if (meshData.flagWaveMesh) {
        meshData.flagWaveMesh.rotation.y = Math.sin(elapsed * 5.5 + unit.q) * 0.18;
      }
      if (meshData.bombLightMat) {
        const blink = Math.sin(elapsed * 7.0) > 0 ? 0xff4444 : 0x7f1d1d;
        meshData.bombLightMat.color.setHex(blink);
      }
      if (meshData.revealedRing.visible) {
        meshData.revealedRing.rotation.z = elapsed * 1.5;
        meshData.revealedRing.position.y = 1.02 + Math.sin(elapsed * 3.5) * 0.04;
      }

      // Check if this unit is currently being dragged in 3D
      if (this.isDraggingActive && this.draggingUnit && unit.id === this.draggingUnit.id && this.dragCurrentWorld) {
        meshData.group.position.set(this.dragCurrentWorld.x, surfaceY + 0.55, this.dragCurrentWorld.z);
        meshData.group.rotation.x = 0.12;
        meshData.group.scale.setScalar(1.08);
        continue;
      }

      meshData.group.scale.setScalar(1.0);

      // Check if this unit is part of an active move or swap animation
      if (anim && unit.id === anim.unit.id) {
        const fromPos = anim.customStartOffset
          ? { x: anim.customStartOffset.fromX, y: anim.customStartOffset.fromY }
          : axialToPixel(anim.fromQ, anim.fromR, this.worldHexSize);
        const toPos = axialToPixel(anim.toQ, anim.toR, this.worldHexSize);
        const curX = fromPos.x + (toPos.x - fromPos.x) * animProgress;
        const curZ = fromPos.y + (toPos.y - fromPos.y) * animProgress;
        const jumpArc = anim.customStartOffset
          ? (1 - animProgress) * 0.45
          : Math.sin(animProgress * Math.PI) * 0.65;

        meshData.group.position.set(curX, surfaceY + jumpArc, curZ);
        meshData.group.rotation.x = Math.sin(animProgress * Math.PI) * 0.18;
        continue;
      }

      if (anim && anim.swapUnit && unit.id === anim.swapUnit.id) {
        const origFrom = axialToPixel(anim.fromQ, anim.fromR, this.worldHexSize);
        const toPos = axialToPixel(anim.toQ, anim.toR, this.worldHexSize);
        const swapX = toPos.x + (origFrom.x - toPos.x) * animProgress;
        const swapZ = toPos.y + (origFrom.y - toPos.y) * animProgress;
        const jumpArc = Math.sin(animProgress * Math.PI) * 0.55;

        meshData.group.position.set(swapX, surfaceY + jumpArc, swapZ);
        meshData.group.rotation.x = -Math.sin(animProgress * Math.PI) * 0.15;
        continue;
      }

      // Stationary unit on its hex
      const pos = axialToPixel(unit.q, unit.r, this.worldHexSize);
      meshData.group.position.set(pos.x, surfaceY, pos.y);
      meshData.group.rotation.x = 0;
    }

    // 5. Update 3D Combat Particles & Shockwave
    this.updateCombatEffects(dt);

    // 6. Render WebGL Scene
    this.webglRenderer.render(this.scene, this.camera);
  };

  private updateCombatEffects(dt: number): void {
    if (this.combatLight.intensity > 0) {
      this.combatLight.intensity = Math.max(0, this.combatLight.intensity - dt * 6.5);
    }

    if (this.shockwaveRing && this.shockwaveProgress > 0) {
      this.shockwaveProgress += dt * 2.2;
      if (this.shockwaveProgress >= 1) {
        this.shockwaveRing.visible = false;
        this.shockwaveProgress = 0;
      } else {
        const s = 0.5 + this.shockwaveProgress * 3.2;
        this.shockwaveRing.scale.setScalar(s);
        (this.shockwaveRing.material as THREE.MeshBasicMaterial).opacity = 1 - this.shockwaveProgress;
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.effectsGroup.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= 9.8 * dt; // Gravity
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.mesh.position.y < 0.08) {
        p.mesh.position.y = 0.08;
        p.vel.y *= -0.45;
        p.vel.x *= 0.7;
        p.vel.z *= 0.7;
      }
      p.mesh.rotation.x += p.rotVel.x * dt;
      p.mesh.rotation.y += p.rotVel.y * dt;
      p.mesh.rotation.z += p.rotVel.z * dt;
      const scale = Math.max(0.01, 1 - p.life / p.maxLife);
      p.mesh.scale.setScalar(scale);
    }
  }

  private updateCameraTransform(): void {
    const sinPhi = Math.sin(this.camPhi);
    const cosPhi = Math.cos(this.camPhi);
    const sinTheta = Math.sin(this.camTheta);
    const cosTheta = Math.cos(this.camTheta);

    let shakeX = 0;
    let shakeY = 0;
    if (this.cameraShakeAmount > 0.002) {
      shakeX = (Math.random() - 0.5) * this.cameraShakeAmount;
      shakeY = (Math.random() - 0.5) * this.cameraShakeAmount;
      this.cameraShakeAmount *= 0.86;
    } else {
      this.cameraShakeAmount = 0;
    }

    this.camera.position.set(
      this.camTarget.x + this.camRadius * sinPhi * sinTheta + shakeX,
      this.camTarget.y + this.camRadius * cosPhi + shakeY,
      this.camTarget.z + this.camRadius * sinPhi * cosTheta
    );
    this.camera.lookAt(this.camTarget);
  }

  // ============================================================================
  // RAYCASTING, DRAG-AND-DROP & 3D CAMERA ORBIT INTERACTION
  // ============================================================================
  private raycastBoardPlane(e: PointerEvent | MouseEvent | WheelEvent): {
    worldX: number;
    worldZ: number;
    axial: AxialCoord;
  } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const intersectPt = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, intersectPt);
    if (!hit) return null;

    const axial = pixelToAxial(intersectPt.x, intersectPt.z, this.worldHexSize);
    return {
      worldX: intersectPt.x,
      worldZ: intersectPt.z,
      axial
    };
  }

  private setupEvents(): void {
    // Prevent context menu on right-click so right-drag orbits the 3D camera smoothly
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    // Mouse Wheel Zoom
    this.canvas.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const zoomStep = e.deltaY > 0 ? 1.05 : -1.05;
        this.zoomCamera(zoomStep);
      },
      { passive: false }
    );

    this.canvas.addEventListener('pointerdown', e => {
      // Right-click (button 2), Middle-click (button 1), or Shift+Left-click => Orbit 3D Camera
      if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this.isOrbiting = true;
        this.orbitStart = {
          x: e.clientX,
          y: e.clientY,
          theta: this.camGoalTheta,
          phi: this.camGoalPhi
        };
        this.canvas.style.cursor = 'move';
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (e.button !== 0) return;

      const hit = this.raycastBoardPlane(e);
      if (!hit) return;
      const { worldX, worldZ, axial } = hit;

      if (!this.game.tiles.has(coordKey(axial.q, axial.r))) {
        // Clicking outside the hex board also allows gentle camera orbit!
        this.isOrbiting = true;
        this.orbitStart = {
          x: e.clientX,
          y: e.clientY,
          theta: this.camGoalTheta,
          phi: this.camGoalPhi
        };
        this.canvas.style.cursor = 'move';
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }

      const unitAtHex = this.game.getUnitAt(axial.q, axial.r);
      if (unitAtHex && this.game.canPlayerDragUnit(unitAtHex)) {
        this.draggingUnit = unitAtHex;
        this.dragStartScreen = { x: e.clientX, y: e.clientY };
        this.dragCurrentWorld = { x: worldX, z: worldZ };
        this.isDraggingActive = false;
        this.canvas.setPointerCapture(e.pointerId);
      }
    });

    this.canvas.addEventListener('pointermove', e => {
      if (this.isOrbiting) {
        const dx = e.clientX - this.orbitStart.x;
        const dy = e.clientY - this.orbitStart.y;
        this.camGoalTheta = this.orbitStart.theta - dx * 0.0075;
        this.camGoalPhi = Math.max(0.12, Math.min(1.18, this.orbitStart.phi - dy * 0.0065));
        return;
      }

      const hit = this.raycastBoardPlane(e);
      if (!hit) return;
      const { worldX, worldZ, axial } = hit;
      const tile = this.game.tiles.get(coordKey(axial.q, axial.r));

      if (this.draggingUnit && this.dragStartScreen) {
        this.dragCurrentWorld = { x: worldX, z: worldZ };
        const dx = e.clientX - this.dragStartScreen.x;
        const dy = e.clientY - this.dragStartScreen.y;
        if (!this.isDraggingActive && Math.hypot(dx, dy) > 6) {
          this.isDraggingActive = true;
          this.game.selectedUnitId = this.draggingUnit.id;
          this.canvas.style.cursor = 'grabbing';
          this.showGhostAtOrigin(this.draggingUnit);
          this.syncSceneWithGame();
        }
        if (this.isDraggingActive) {
          const prevKey = this.hoveredHex ? coordKey(this.hoveredHex.q, this.hoveredHex.r) : '';
          const newKey = tile ? coordKey(axial.q, axial.r) : '';
          if (prevKey !== newKey) {
            this.hoveredHex = tile ? axial : null;
            this.syncSceneWithGame();
          }
          return;
        }
      }

      const prevKey = this.hoveredHex ? coordKey(this.hoveredHex.q, this.hoveredHex.r) : '';
      const newKey = tile ? coordKey(axial.q, axial.r) : '';

      if (prevKey !== newKey) {
        this.hoveredHex = tile ? axial : null;
        const unit = tile ? this.game.getUnitAt(axial.q, axial.r) : undefined;
        if (unit && this.game.canPlayerDragUnit(unit)) {
          this.canvas.style.cursor = 'grab';
        } else {
          this.canvas.style.cursor = tile ? 'pointer' : 'default';
        }
        this.syncSceneWithGame();
      }
    });

    const finishPointer = (e: PointerEvent) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }

      if (this.isOrbiting) {
        this.isOrbiting = false;
        this.canvas.style.cursor = 'default';
        return;
      }

      const hit = this.raycastBoardPlane(e);
      const axial = hit ? hit.axial : { q: 999, r: 999 };

      if (this.draggingUnit && this.isDraggingActive) {
        const unit = this.draggingUnit;
        const dropOffset = this.dragCurrentWorld
          ? { fromX: this.dragCurrentWorld.x, fromY: this.dragCurrentWorld.z }
          : undefined;

        this.draggingUnit = null;
        this.dragStartScreen = null;
        this.dragCurrentWorld = null;
        this.isDraggingActive = false;
        this.hideGhostAtOrigin();
        this.canvas.style.cursor = 'default';

        const dropped = this.game.handleUnitDrop(unit, axial.q, axial.r, true, dropOffset);
        if (!dropped && dropOffset) {
          this.game.activeMoveAnim = {
            unit,
            fromQ: unit.q,
            fromR: unit.r,
            toQ: unit.q,
            toR: unit.r,
            startTime: performance.now(),
            duration: 200,
            customStartOffset: dropOffset
          };
        }
        this.syncSceneWithGame();
        return;
      }

      this.draggingUnit = null;
      this.dragStartScreen = null;
      this.dragCurrentWorld = null;
      this.isDraggingActive = false;
      this.hideGhostAtOrigin();

      if (this.game.tiles.has(coordKey(axial.q, axial.r))) {
        this.game.handleTileClick(axial.q, axial.r);
      }
    };

    this.canvas.addEventListener('pointerup', finishPointer);
    this.canvas.addEventListener('pointercancel', () => {
      this.isOrbiting = false;
      this.draggingUnit = null;
      this.dragStartScreen = null;
      this.dragCurrentWorld = null;
      this.isDraggingActive = false;
      this.hideGhostAtOrigin();
      this.syncSceneWithGame();
    });

    this.canvas.addEventListener('mouseleave', () => {
      if (!this.isDraggingActive && !this.isOrbiting && this.hoveredHex) {
        this.hoveredHex = null;
        this.syncSceneWithGame();
      }
    });
  }

  private showGhostAtOrigin(unit: Unit): void {
    this.hideGhostAtOrigin();
    const pos = axialToPixel(unit.q, unit.r, this.worldHexSize);
    const g = new THREE.Group();
    g.position.set(pos.x, 0.08, pos.y);

    const ghostCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.50, 0.45, 20),
      new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.28,
        wireframe: false
      })
    );
    ghostCyl.position.y = 0.22;
    g.add(ghostCyl);

    this.ghostUnitGroup = g;
    this.highlightsGroup.add(g);
  }

  private hideGhostAtOrigin(): void {
    if (this.ghostUnitGroup) {
      this.highlightsGroup.remove(this.ghostUnitGroup);
      this.ghostUnitGroup = null;
    }
  }
}
