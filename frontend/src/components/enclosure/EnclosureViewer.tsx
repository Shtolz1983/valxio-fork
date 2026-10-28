/**
 * Interactive 3D view of a built enclosure: drag to rotate, wheel to zoom,
 * right-drag to pan. Loaded lazily by EnclosureDialog so three.js stays out
 * of the editor's main bundle.
 *
 * Meshes arrive in board coordinates (mm, Z up, origin at the PCB's
 * lower-left corner), so the scene uses Z as "up" too and nothing is moved
 * except the lid, which `lift` raises to show the inside.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { EnclosureBuild } from '../../services/enclosureService';

// Same palette as the backend's PNG render (render.py COLORS).
const COLORS = { base: 0x8c9eb8, lid: 0xb8ad94, pcb: 0x268c4d, connector: 0xf28c1a, battery: 0x4d5c8c, module: 0x339e9e };

interface Props {
  build: EnclosureBuild;
  /** mm the lid is raised above its seat. */
  lift: number;
  showBoard: boolean;
}

interface Scene {
  lid: THREE.Group;
  hatch: THREE.Mesh | null;
  board: THREE.Group;
  render: () => void;
}

function geometry(stlBase64: string): THREE.BufferGeometry {
  const bytes = Uint8Array.from(atob(stlBase64), (c) => c.charCodeAt(0));
  return new STLLoader().parse(bytes.buffer);
}

function mesh(stlBase64: string, color: number): THREE.Mesh {
  return new THREE.Mesh(geometry(stlBase64), new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 }));
}

export default function EnclosureViewer({ build, lift, showBoard }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    // The key light rides with the camera, so the face looked at is always lit.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.4, 0.6, 1);
    camera.add(key);
    scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));

    // the lid with the displays hung under it
    const lid = new THREE.Group();
    lid.add(mesh(build.lid_stl, COLORS.lid));
    if (build.lid_modules_stl) lid.add(mesh(build.lid_modules_stl, COLORS.module));
    const board = new THREE.Group();
    board.add(mesh(build.pcb_stl, COLORS.pcb));
    if (build.connectors_stl) board.add(mesh(build.connectors_stl, COLORS.connector));
    if (build.battery_stl) board.add(mesh(build.battery_stl, COLORS.battery));
    if (build.modules_stl) board.add(mesh(build.modules_stl, COLORS.module));
    // the battery hatch drops out of the floor as the lid lifts, to show it is a part of its own
    const hatch = build.hatch_stl ? mesh(build.hatch_stl, COLORS.lid) : null;
    scene.add(mesh(build.base_stl, COLORS.base), lid, board, ...(hatch ? [hatch] : []));

    // Frame the closed box from the front-left, as the PNG's ISO view does.
    const { x0, y0, x1, y1, z0, z1 } = build.outer;
    const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const size = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    camera.position.copy(center).add(new THREE.Vector3(-0.55, -1.25, 0.95).multiplyScalar(size * 1.15));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();

    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    sceneRef.current = { lid, hatch, board, render };

    return () => {
      sceneRef.current = null;
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [build]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.lid.position.z = lift;
    if (s.hatch) s.hatch.position.z = -lift / 2;
    s.board.visible = showBoard;
    s.render();
  }, [build, lift, showBoard]);

  return <div className="enc-viewer" ref={hostRef} />;
}
