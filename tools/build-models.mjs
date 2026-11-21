// Builds the AR plant catalog from Poly Haven (CC0) glTF downloads.
// Usage: node build-models.mjs <polyhaven-dir> <out-dir>
// <polyhaven-dir>/<asset>/<asset>.gltf, as downloaded from api.polyhaven.com (1k).
// Each catalog item = picked nodes from one or more assets, placed with an offset,
// then centered on x/z, standing on y=0, textures shrunk to webp, meshes compressed.
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {mergeDocuments, getBounds, prune, dedup, textureCompress, meshopt, weld, simplify, unpartition} from '@gltf-transform/functions';
import {MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';
import sharp from 'sharp';
import path from 'node:path';

const [,, SRC, OUT] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({'meshopt.encoder': MeshoptEncoder});

// parts: [asset, [node names] | null (all), [x,y,z] offset, scale]
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const CATALOG = {
  // Outdoor trees (LeafCon's core product). Simplified hard: originals have millions of triangles.
  youngtree: {tex: 1024, simplify: 0.03, parts: [['tree_small_02', null, [0, 0, 0], 1]]},
  islandtree: {tex: 1024, simplify: 0.06, parts: [['island_tree_02', null, [0, 0, 0], 1]]},
  ficus: {tex: 1024, parts: [['potted_plant_01', null, [0, 0, 0], 1]]},
  syngonium: {tex: 1024, parts: [['potted_plant_02', null, [0, 0, 0], 1]]},
  moneytree: {tex: 1024, parts: [
    ['potted_plant_02', ['potted_plant_02_pot', 'potted_plant_02_dirt'], [0, 0, 0], 1.3],
    ['pachira_aquatica_01', ['pachira_aquatica_01_bark_d', 'pachira_aquatica_01_leaves_d'], ['center', 0.40, 'center'], 0.82],
  ]},
  planter: {tex: 1024, parts: [
    ['planter_box_02', null, [0, 0, 0], 1],
    ['fern_02', ['fern_02_c'], [-0.35, 0.30, 0], 0.75],
    ['anthurium_botany_01', ['anthurium_botany_01_b'], [0.05, 0.30, 0], 0.9],
    ['calathea_orbifolia_01', ['calathea_orbifolia_01_a'], [0.42, 0.30, 0.02], 0.8],
  ]},
  raisedbed: {tex: 1024, parts: [
    ['planter_box_03', null, [0, 0, 0], 1],
    ['fern_02', ['fern_02_b'], [-0.15, 0.72, 0], 0.7],
    ['calathea_orbifolia_01', ['calathea_orbifolia_01_a'], [0.22, 0.72, 0.05], 0.75],
  ]},
};

async function loadPart(asset, names, offset, scale) {
  const doc = await io.read(path.join(SRC, asset, `${asset}.gltf`));
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const n of scene.listChildren()) {
    if (names && !names.includes(n.getName())) n.dispose();
  }
  const kept = scene.listChildren();
  if (names && kept.length !== names.length) throw new Error(`${asset}: missing nodes, kept ${kept.map(n => n.getName())}`);
  // Wrap kept nodes in a parent; move them so their footprint is centered when asked.
  const b = getBounds(scene);
  // x/z: put the part's center at the offset. y: put the part's bottom at the offset.
  const at = (i) => (offset[i] === 'center' ? 0 : offset[i]);
  const off = [
    at(0) - (b.min[0] + b.max[0]) / 2 * scale,
    at(1) - b.min[1] * scale,
    at(2) - (b.min[2] + b.max[2]) / 2 * scale,
  ];
  const parent = doc.createNode(asset).setTranslation(off).setScale([scale, scale, scale]);
  for (const n of kept) { scene.removeChild(n); parent.addChild(n); }
  scene.addChild(parent);
  return doc;
}

for (const [id, item] of Object.entries(CATALOG)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const docs = [];
  for (const [asset, names, offset, scale] of item.parts) docs.push(await loadPart(asset, names, offset, scale));
  const target = docs[0];
  const mainScene = target.getRoot().listScenes()[0];
  for (const src of docs.slice(1)) {
    const map = mergeDocuments(target, src);
    for (const s of src.getRoot().listScenes()) {
      const ts = map.get(s);
      for (const c of ts.listChildren()) { ts.removeChild(c); mainScene.addChild(c); }
      ts.dispose();
    }
  }
  target.getRoot().setDefaultScene(mainScene);
  // Center the whole item on x/z and put it on the floor (y=0).
  const b = getBounds(mainScene);
  const root = target.createNode(id).setTranslation([-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2]);
  for (const c of mainScene.listChildren()) { mainScene.removeChild(c); root.addChild(c); }
  mainScene.addChild(root);

  await target.transform(
    unpartition(),
    dedup(),
    prune(),
    weld(),
    ...(item.simplify ? [simplify({simplifier: MeshoptSimplifier, ratio: item.simplify, error: 0.01})] : []),
    textureCompress({encoder: sharp, targetFormat: 'webp', resize: [item.tex, item.tex]}),
    meshopt({encoder: MeshoptEncoder, level: 'medium'}),
  );
  const outFile = path.join(OUT, `${id}.glb`);
  await io.write(outFile, target);
  const fb = getBounds(target.getRoot().listScenes()[0]);
  console.log(id, 'size m:', fb.max.map((v, i) => (v - fb.min[i]).toFixed(2)).join(' x '));
}
