// Computational verification of fish geometry orientation.
// Runs without WebGPU — just uses three.js core to build the geometry
// and inspects vertex bounds per piece to confirm each fin is in the
// right octant (head +X, tail -X, top +Y, sides ±Z).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Re-implement makeFishGeometry but build each piece SEPARATELY so we
// can inspect bounds per piece (the merged geom drops the per-piece info).
function buildPieces() {
  const body = new THREE.IcosahedronGeometry(0.35, 1);
  body.scale(2.0, 0.75, 0.5);

  const tail = new THREE.ConeGeometry(0.4, 0.6, 4);
  tail.rotateZ(Math.PI / 2);
  tail.scale(1, 1, 0.14);
  tail.translate(-0.7, 0, 0);

  const dorsal = new THREE.ConeGeometry(0.18, 0.35, 3);
  dorsal.scale(0.55, 1, 0.13);
  dorsal.translate(-0.15, 0.27, 0);

  const anal = new THREE.ConeGeometry(0.12, 0.2, 3);
  anal.rotateZ(Math.PI);
  anal.scale(0.5, 1, 0.12);
  anal.translate(-0.4, -0.26, 0);

  const finL = new THREE.ConeGeometry(0.14, 0.28, 3);
  finL.rotateX(Math.PI / 2);
  finL.scale(0.7, 0.13, 1);
  finL.rotateY(-Math.PI * 0.22);
  finL.translate(0.1, -0.1, 0.18);

  const finR = new THREE.ConeGeometry(0.14, 0.28, 3);
  finR.rotateX(-Math.PI / 2);
  finR.scale(0.7, 0.13, 1);
  finR.rotateY(Math.PI * 0.22);
  finR.translate(0.1, -0.1, -0.18);

  return { body, tail, dorsal, anal, finL, finR };
}

function reportBounds(name, geom) {
  geom.computeBoundingBox();
  const b = geom.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
  const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
  console.log(
    name.padEnd(8),
    `X[${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}] center=${cx.toFixed(2)} size=${sx.toFixed(2)}  ` +
    `Y[${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}] center=${cy.toFixed(2)} size=${sy.toFixed(2)}  ` +
    `Z[${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}] center=${cz.toFixed(2)} size=${sz.toFixed(2)}`
  );
  return { cx, cy, cz, sx, sy, sz, b };
}

function check(label, cond) {
  console.log(cond ? "  PASS" : "  FAIL", "—", label);
  return cond;
}

const pieces = buildPieces();
console.log("Per-piece bounding boxes (fish nose should be at +X, tail at -X):\n");
const stats = {};
for (const [name, g] of Object.entries(pieces)) {
  stats[name] = reportBounds(name, g);
}

console.log("\nOrientation invariants:");
let allOk = true;

// Body: center near origin, extends in +X (nose) and -X (rear of body)
allOk &= check("Body roughly centered, longer in X than Y or Z",
  Math.abs(stats.body.cx) < 0.05 && stats.body.sx > stats.body.sy && stats.body.sx > stats.body.sz);

// Tail: fully rearward of body (X < 0)
allOk &= check("Tail entirely in -X (rearward of body)",
  stats.tail.b.max.x <= 0);
allOk &= check("Tail extends further back than body (tail.min.x < body.min.x)",
  stats.tail.b.min.x < stats.body.b.min.x);
allOk &= check("Tail is a vertical fin (Y span > Z span)",
  stats.tail.sy > stats.tail.sz * 3);

// Dorsal: above body (Y > 0)
allOk &= check("Dorsal fully above midline (Y > 0)",
  stats.dorsal.b.min.y >= 0);
allOk &= check("Dorsal tip above body top",
  stats.dorsal.b.max.y > stats.body.b.max.y);
allOk &= check("Dorsal is a vertical fin (Y span > Z span)",
  stats.dorsal.sy > stats.dorsal.sz * 3);

// Anal: below body (Y < 0)
allOk &= check("Anal fully below midline (Y < 0)",
  stats.anal.b.max.y <= 0);
allOk &= check("Anal tip below body bottom",
  stats.anal.b.min.y < stats.body.b.min.y);

// Pectoral L: center in +Z half
allOk &= check("FinL center in +Z half (left side)",
  stats.finL.cz > 0);
allOk &= check("FinL extends sideways from body (max.z beyond body.max.z)",
  stats.finL.b.max.z > stats.body.b.max.z);

// Pectoral R: center in -Z half
allOk &= check("FinR center in -Z half (right side)",
  stats.finR.cz < 0);
allOk &= check("FinR extends sideways from body (min.z beyond body.min.z)",
  stats.finR.b.min.z < stats.body.b.min.z);

// Pectoral sweep — tip end (where |z| is largest) should be at smaller X
// than base end (near body, smaller |z|). Use a vertex-level test: find the
// outermost vertex by |z| and confirm it has lower x than the innermost.
function fanSweepBackward(geom) {
  const pos = geom.attributes.position.array;
  let outerIdx = 0, innerIdx = 0;
  let outerZ = -1, innerZ = 1e9;
  for (let i = 0; i < pos.length; i += 3) {
    const az = Math.abs(pos[i + 2]);
    if (az > outerZ) { outerZ = az; outerIdx = i; }
    if (az < innerZ) { innerZ = az; innerIdx = i; }
  }
  return pos[outerIdx] < pos[innerIdx];   // outer tip x < inner base x  →  back-swept
}
allOk &= check("FinL back-swept (outer tip at smaller x than inner base)",
  fanSweepBackward(pieces.finL));
allOk &= check("FinR back-swept",
  fanSweepBackward(pieces.finR));

console.log("\n" + (allOk ? "ALL PASS — fish geometry orientation looks correct." : "SOME FAILED — geometry still wrong."));
process.exit(allOk ? 0 : 1);
