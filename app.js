// LeafCon AR: place real-size plants in your office.
// Based on the 8th Wall "placeground" three.js example (tap the floor to place a model).
// Modes: AR (default, 8th Wall world tracking) and ?preview (desktop 3D view, no camera, for testing).
import * as THREE from 'three'
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js'
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'
import {GroundedSkybox} from 'three/addons/objects/GroundedSkybox.js'

window.THREE = THREE  // 8th Wall's XR8.Threejs module reads window.THREE.

// kind 'tree' = outdoor tree (counts towards shade). kind 'plant' = office green.
const PLANTS = [
  {id: 'youngtree', kind: 'tree', name: 'City tree', size: '4.5 m'},
  {id: 'islandtree', kind: 'tree', name: 'Multi-stem', size: '3.4 m'},
  {id: 'ficus', kind: 'plant', name: 'Ficus', size: '1.35 m'},
  {id: 'moneytree', kind: 'plant', name: 'Money tree', size: '1.9 m'},
  {id: 'syngonium', kind: 'plant', name: 'Syngonium', size: '0.85 m'},
  {id: 'planter', kind: 'plant', name: 'Planter', size: '1.3 m wide'},
  {id: 'raisedbed', kind: 'plant', name: 'Raised bed', size: '1 m'},
]
const KIND = Object.fromEntries(PLANTS.map((p) => [p.id, p.kind]))
const CAMERA_HEIGHT = 1.45  // metres, phone held at chest height. Sets the AR scale.
const params = new URLSearchParams(location.search)
let PREVIEW = params.has('preview') || params.has('demo')

const $ = (id) => document.getElementById(id)
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
const cache = new Map()  // id -> Promise<THREE.Object3D>
const loadPlant = (id) => {
  if (!cache.has(id)) {
    cache.set(id, loader.loadAsync(`models/${id}.glb`).then((g) => {
      g.scene.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
      })
      // Crown footprint (circle over the mean of width and depth): the shade at midday.
      const s = new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3())
      g.scene.userData.shadeM2 = Math.PI * Math.pow((s.x + s.z) / 4, 2)
      g.scene.userData.crownR = (s.x + s.z) / 4
      g.scene.userData.footR = Math.max(s.x, s.z) / 2
      state.protos = state.protos || {}
      state.protos[id] = g.scene
      return g.scene
    }).catch((e) => { cache.delete(id); throw e }))
  }
  return cache.get(id)
}

const state = {
  selectedType: PLANTS[0].id,
  placed: [],       // {root, type}
  active: null,     // placed plant being edited
  floorFound: false,
  world: null,      // {scene, camera, renderer}
  anims: [],
  maxPlace: PREVIEW ? 25 : 12,  // metres; far hits are imprecise
}

// Table mode: a phone less than 1 m above the surface points at a table, not the floor.
// A 4.5 m tree on a table is just a pole, so trees become 1:12 models on an asphalt tile.
const TABLE_MAX_HEIGHT = 1.0
const MINI = 1 / 12
const onTable = () => params.has('table') || (!PREVIEW && state.world?.camera.position.y < TABLE_MAX_HEIGHT)

// Soft round textures, drawn once: a dark contact shadow and a cool shade patch.
function radialTexture(inner, outer) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, inner); grad.addColorStop(0.55, inner); grad.addColorStop(1, outer)
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}
// Asphalt tile with parking lines and a scale label, for 1:12 trees.
function asphaltTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  g.fillStyle = '#5b5d5c'
  g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill()
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.12})`
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2)
  }
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 5
  for (const x of [52, 204]) { g.beginPath(); g.moveTo(x, 40); g.lineTo(x, 150); g.stroke() }
  g.fillStyle = '#ffffff'; g.font = '700 30px "IBM Plex Mono", monospace'; g.textAlign = 'center'
  g.fillText('1:12', 128, 222)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
let blobTex, shadeTex, tileTex
function flatDisc(radius, material, y) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), material)
  m.rotateX(-Math.PI / 2)
  m.position.y = y
  return m
}
const noRaycast = (m) => { m.raycast = () => {}; return m }

// ---------- Scene ----------
let floor, reticle, selRing
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()

function initScene({scene, camera, renderer}) {
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.0

  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.9

  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(1.5, 4, 2)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 10
  sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 40
  sun.shadow.bias = -0.0005
  sun.shadow.radius = 4
  scene.add(sun, sun.target)
  state.sun = sun
  state.sunDir = new THREE.Vector3(0.3, 1, 0.4).normalize()  // nearly overhead, like ceiling light

  // Invisible floor that only shows shadows. Used for tap raycasts.
  floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({opacity: 0.4}))
  floor.rotateX(-Math.PI / 2)
  floor.receiveShadow = true
  scene.add(floor)

  // Placement reticle: a ring on the floor where the centre of the screen points.
  reticle = new THREE.Group()
  blobTex = radialTexture('rgba(0,0,0,.6)', 'rgba(0,0,0,0)')
  shadeTex = radialTexture('rgba(110,190,255,.30)', 'rgba(110,190,255,0)')
  tileTex = asphaltTexture()
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.9}))
  state.reticleRing = ring
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), new THREE.MeshBasicMaterial({color: 0x2F7D4F}))
  ring.rotateX(-Math.PI / 2); dot.rotateX(-Math.PI / 2)
  ring.position.y = dot.position.y = 0.003
  reticle.add(ring, dot)
  reticle.visible = false
  scene.add(reticle)

  selRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 64), new THREE.MeshBasicMaterial({color: 0x2F7D4F, transparent: true, opacity: 0.95}))
  selRing.rotateX(-Math.PI / 2)
  selRing.visible = false
  scene.add(selRing)

  state.world = {scene, camera, renderer}
  loadPlant(state.selectedType).catch(() => {})
}

function floorHitAt(clientX, clientY) {
  const {camera, renderer} = state.world
  const r = renderer.domElement.getBoundingClientRect()
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
  const hit = raycaster.intersectObject(floor)[0]
  if (!hit) return null
  // Ignore hits too far away: they are imprecise and place plants out of view.
  if (hit.distance > state.maxPlace) return null
  return hit.point
}

function plantHitAt(clientX, clientY) {
  const {camera, renderer} = state.world
  const r = renderer.domElement.getBoundingClientRect()
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
  const hits = raycaster.intersectObjects(state.placed.map((p) => p.root), true)
  if (!hits.length) return null
  let o = hits[0].object
  while (o && !o.userData.plant) o = o.parent
  return o ? o.userData.plant : null
}

const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2)
function animate(obj, from, to, ms, prop = 'scale') {
  state.anims.push({obj, from, to, ms, prop, t0: performance.now()})
}
function tick(now) {
  state.anims = state.anims.filter((a) => {
    const t = Math.min(1, (now - a.t0) / a.ms)
    const k = easeOutBack(t)
    if (a.prop === 'scale') a.obj.scale.setScalar(a.from + (a.to - a.from) * k)
    else if (a.prop === 'rotY') a.obj.rotation.y = a.from + (a.to - a.from) * (1 - Math.pow(1 - t, 3))
    return t < 1
  })
  followSun()
  updateReticle()
  if (state.active) {
    selRing.position.set(state.active.root.position.x, 0.004, state.active.root.position.z)
  }
}

const _fwd = new THREE.Vector3()
function followSun() {
  const {sun, sunDir, world} = state
  if (!sun || !world) return
  // Centre the shadow box a few metres in front of the camera, on the floor.
  world.camera.getWorldDirection(_fwd).setY(0)
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1)
  _fwd.normalize().multiplyScalar(4).add(world.camera.position).setY(0)
  sun.target.position.copy(_fwd)
  sun.position.copy(_fwd).addScaledVector(sunDir, 15)
}

// How big the next plant is: trees show their shade circle, plants their footprint.
function scaleFor(type) {
  return KIND[type] === 'tree' && onTable() ? MINI : 1
}
let reticleKey = ''
function sizeReticle() {
  const type = state.selectedType
  const key = type + '|' + scaleFor(type)
  if (key === reticleKey) return
  const proto = state.protos?.[type]
  if (!proto) return
  reticleKey = key
  const k = scaleFor(type)
  const r = Math.max(0.12, (KIND[type] === 'tree' ? proto.userData.crownR : proto.userData.footR) * k)
  const ring = state.reticleRing
  ring.geometry.dispose()
  ring.geometry = new THREE.RingGeometry(r - Math.min(0.05, r * 0.2), r, 64)
}

function updateReticle() {
  if (!state.world || !reticle) return
  const r = state.world.renderer.domElement.getBoundingClientRect()
  const p = floorHitAt(r.left + r.width / 2, r.top + r.height * 0.55)
  reticle.visible = !!p && !state.active && !state.shooting
  sizeReticle()
  if (p) {
    reticle.position.set(p.x, 0, p.z)
    if (!state.floorFound) {
      state.floorFound = true
      setHint('Pick a plant below. Tap the floor to plant it.')
    }
  }
}

async function placeAt(point) {
  const type = state.selectedType
  let proto
  try {
    proto = await loadPlant(type)
  } catch (e) {
    setHint('Could not load the plant. Check your connection and tap again.', true)
    return
  }
  const isTree = KIND[type] === 'tree'
  const mini = scaleFor(type) !== 1
  // Trees vary a little in size so a group does not look copy-pasted.
  const vary = isTree ? 0.9 + Math.random() * 0.2 : 1
  const k = scaleFor(type) * vary
  const root = new THREE.Group()
  const body = proto.clone(true)
  body.scale.setScalar(k)
  body.rotation.y = Math.random() * Math.PI * 2 * (isTree ? 1 : 0)
  root.add(body)
  const {crownR, footR} = proto.userData
  const lift = (state.placed.length % 10) * 0.0006  // overlapping discs must not flicker
  root.add(noRaycast(flatDisc(Math.max(0.08, footR * k * 0.75), new THREE.MeshBasicMaterial({map: blobTex, transparent: true, depthWrite: false}), 0.004 + lift)))
  if (isTree) root.add(noRaycast(flatDisc(crownR * k * 1.1, new THREE.MeshBasicMaterial({map: shadeTex, transparent: true, depthWrite: false}), 0.003 + lift)))
  if (mini) {
    const tile = flatDisc(Math.max(0.16, crownR * k * 1.5), new THREE.MeshStandardMaterial({map: tileTex, roughness: 0.95}), 0.002 + lift)
    tile.receiveShadow = true
    root.add(tile)
  }
  root.position.set(point.x, 0, point.z)
  // Face the plant's front to the viewer, with a little random turn so groups look natural.
  const cam = state.world.camera.position
  root.rotation.y = Math.atan2(cam.x - point.x, cam.z - point.z) + (Math.random() - 0.5) * 0.6
  root.scale.setScalar(0.01)
  const plant = {root, type, shadeM2: proto.userData.shadeM2 * vary * vary}
  root.userData.plant = plant
  state.world.scene.add(root)
  state.placed.push(plant)
  animate(root, 0.01, 1, 650)
  updateCount()
  if (mini && !state.miniHinted) {
    state.miniHinted = true
    setHint('Table spotted: trees show as 1:12 models. Point at the floor for real size.', false, 5000)
  } else if (state.placed.length === 1) setHint('Nice. Drag to move it. Tap it to rotate or remove.', false, 3500)
  else if (state.placed.length === 3) setHint('Looks good! Tap the camera to keep your green plan.', false, 4000)
  else hideHint()
  $('photo').classList.toggle('pulse', state.placed.length >= 3)
}

function select(plant) {
  state.active = plant
  selRing.visible = !!plant
  $('selbar').classList.toggle('hidden', !plant)
  if (plant) {
    // Size the ring to the plant footprint.
    const box = new THREE.Box3().setFromObject(plant.root)
    const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 + 0.08
    selRing.scale.setScalar(r / 0.53)
  }
}

function removePlant(plant) {
  state.world.scene.remove(plant.root)
  state.placed = state.placed.filter((p) => p !== plant)
  if (state.active === plant) select(null)
  updateCount()
}

// The live business line: what the placed trees cost and how much shade they give.
function summary() {
  const trees = state.placed.filter((p) => KIND[p.type] === 'tree')
  const plants = state.placed.length - trees.length
  const shade = Math.round(trees.reduce((a, p) => a + (p.shadeM2 || 0), 0))
  const parts = []
  if (trees.length) parts.push(trees.length === 1 ? '1 tree' : `${trees.length} trees`)
  if (plants) parts.push(plants === 1 ? '1 plant' : `${plants} plants`)
  return {
    trees: trees.length, plants, shade,
    title: parts.join(' + ') || 'Nothing planted yet',
    shadeText: trees.length ? `≈ ${shade} m² of shade` : '',
  }
}
function updateCount() {
  const s = summary()
  $('count').textContent = s.title
  $('shade').textContent = s.shadeText
  $('shade').classList.toggle('hidden', !s.shadeText)
}

let hintTimer
function setHint(text, isError = false, autoHideMs = 0) {
  const h = $('hint')
  h.textContent = text
  h.style.opacity = '1'
  h.style.background = isError ? 'rgba(180,35,24,.85)' : ''
  clearTimeout(hintTimer)
  if (autoHideMs) hintTimer = setTimeout(hideHint, autoHideMs)
}
function hideHint() { $('hint').style.opacity = '0' }

// ---------- Touch / pointer ----------
function bindPointer(canvas) {
  let down = null  // {x, y, plant, moved, offset}
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return
    const plant = plantHitAt(e.clientX, e.clientY)
    let offset = null
    if (plant) {
      const p = floorHitAt(e.clientX, e.clientY)
      if (p) offset = new THREE.Vector3().subVectors(plant.root.position, p).setY(0)
    }
    down = {x: e.clientX, y: e.clientY, plant, moved: false, offset}
    canvas.setPointerCapture?.(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!down || !e.isPrimary) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true
    if (down.moved && down.plant && down.offset) {
      const p = floorHitAt(e.clientX, e.clientY)
      if (p) down.plant.root.position.set(p.x + down.offset.x, 0, p.z + down.offset.z)
    }
  })
  const end = (e) => {
    if (!down || !e.isPrimary) return
    const d = down
    down = null
    if (d.moved) return  // drag (move plant, or orbit in preview)
    if (d.plant) { select(state.active === d.plant ? null : d.plant); return }
    if (state.active) { select(null); return }
    const p = floorHitAt(e.clientX, e.clientY)
    if (p) placeAt(p)
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', () => { down = null })
  // Stop the page from scrolling or zooming while touching the AR view.
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), {passive: false})
  return () => !!down?.plant  // tells preview controls when a plant drag is active
}

// ---------- UI ----------
function buildTray() {
  const tray = $('tray')
  let lastKind = null
  for (const p of PLANTS) {
    if (p.kind !== lastKind) {
      const label = document.createElement('span')
      label.className = 'tray-label'
      label.textContent = p.kind === 'tree' ? 'Trees' : 'Office green'
      tray.appendChild(label)
      lastKind = p.kind
    }
    const b = document.createElement('button')
    b.className = 'item'
    b.dataset.id = p.id
    b.type = 'button'
    b.setAttribute('aria-pressed', String(p.id === state.selectedType))
    b.innerHTML = `<img src="thumbs/${p.id}.webp" alt=""><span class="n">${p.name}</span><span class="s">${p.size}</span>`
    b.addEventListener('click', () => {
      state.selectedType = p.id
      tray.querySelectorAll('.item').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      loadPlant(p.id).catch(() => {})
      select(null)
    })
    tray.appendChild(b)
  }
}

function bindButtons() {
  $('rotate').addEventListener('click', () => {
    const a = state.active
    if (a) animate(a.root, a.root.rotation.y, a.root.rotation.y + Math.PI / 4, 300, 'rotY')
  })
  $('remove').addEventListener('click', () => state.active && removePlant(state.active))
  $('done').addEventListener('click', () => select(null))
  $('undo').addEventListener('click', () => {
    const last = state.placed[state.placed.length - 1]
    if (last) removePlant(last)
  })
  $('photo').addEventListener('click', takePhoto)
  $('closeSheet').addEventListener('click', () => $('sheet').classList.add('hidden'))
  $('share').addEventListener('click', sharePhoto)
}

let lastPhotoBlob = null
async function takePhoto() {
  const wasActive = state.active
  select(null)
  reticle.visible = false; state.shooting = true
  const flash = $('flash')
  flash.style.opacity = '0.9'
  setTimeout(() => { flash.style.opacity = '0' }, 120)
  try {
    let dataUrl
    if (PREVIEW) {
      const {renderer, scene, camera} = state.world
      renderer.render(scene, camera)
      const c = document.createElement('canvas')
      c.width = renderer.domElement.width; c.height = renderer.domElement.height
      const ctx = c.getContext('2d')
      ctx.drawImage(renderer.domElement, 0, 0)
      stampBrand(ctx, c)
      dataUrl = c.toDataURL('image/jpeg', 0.9)
    } else {
      const b64 = await XR8.CanvasScreenshot.takeScreenshot({onProcessFrame: ({ctx, canvas}) => stampBrand(ctx, canvas)})
      dataUrl = 'data:image/jpeg;base64,' + b64
    }
    lastPhotoBlob = await (await fetch(dataUrl)).blob()
    $('shot').src = dataUrl
    const s = summary()
    $('planTitle').textContent = s.title
    $('planShade').textContent = s.shadeText
    $('planShade').classList.toggle('hidden', !s.shadeText)
    $('sheet').classList.remove('hidden')
  } catch (e) {
    setHint('Photo failed. Try again.', true, 2500)
  }
  state.shooting = false
  if (wasActive) select(wasActive)
}

// Burns a LeafCon footer into the photo: logo, claim, what was planted and the shade.
function stampBrand(ctx, canvas) {
  const s = canvas.width / 400
  const sum = summary()
  const lines = sum.shadeText ? [sum.shadeText] : []
  const h = (62 + lines.length * 21) * s
  const y = canvas.height - h
  ctx.save()
  const grad = ctx.createLinearGradient(0, y - 30 * s, 0, canvas.height)
  grad.addColorStop(0, 'rgba(23,34,27,0)')
  grad.addColorStop(0.35, 'rgba(23,34,27,.8)')
  grad.addColorStop(1, 'rgba(23,34,27,.94)')
  ctx.fillStyle = grad
  ctx.fillRect(0, y - 30 * s, canvas.width, h + 30 * s)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#9FD8B2'
  ctx.font = `700 ${26 * s}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.fillText('LeafCon', 16 * s, y + 26 * s)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `500 ${14 * s}px "Instrument Sans", system-ui, sans-serif`
  ctx.fillText('The air-con made of leaves', 128 * s, y + 25 * s)
  ctx.font = `600 ${17 * s}px "Instrument Sans", system-ui, sans-serif`
  ctx.fillText(`My green plan: ${sum.title}`, 16 * s, y + 51 * s)
  ctx.fillStyle = '#CFE9D8'
  ctx.font = `500 ${13 * s}px "IBM Plex Mono", ui-monospace, monospace`
  lines.forEach((t, i) => ctx.fillText(t, 16 * s, y + (73 + i * 21) * s))
  ctx.restore()
}

async function sharePhoto() {
  if (!lastPhotoBlob) return
  const file = new File([lastPhotoBlob], 'leafcon-green-office.jpg', {type: 'image/jpeg'})
  if (navigator.canShare?.({files: [file]})) {
    try { await navigator.share({files: [file], title: 'My green office by LeafCon'}) } catch (e) { /* user closed the share sheet */ }
  } else {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(file)
    a.download = file.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
}

// ---------- AR mode (8th Wall) ----------
function leafconModule() {
  return {
    name: 'leafcon',
    onStart: ({canvas}) => {
      const {scene, camera, renderer} = XR8.Threejs.xrScene()
      initScene({scene, camera, renderer})
      camera.position.set(0, CAMERA_HEIGHT, 0)
      XR8.XrController.updateCameraProjectionMatrix({origin: camera.position, facing: camera.quaternion})
      bindPointer(canvas)
      $('ui').classList.remove('hidden')
      setHint('Move your phone slowly to find the floor.')
    },
    onUpdate: ({processCpuResult}) => {
      const light = processCpuResult?.reality?.lighting
      if (light && typeof light.exposure === 'number') matchRoomLight(light.exposure)
      tick(performance.now())
    },
  }
}

// exposure: -1 (dark room) .. 1 (bright). Plants follow it so they are not brighter than the room.
let lightLevel = 1
function matchRoomLight(exposure) {
  const target = THREE.MathUtils.clamp(1 + exposure, 0.35, 1.4)
  lightLevel += (target - lightLevel) * 0.05
  state.world.scene.environmentIntensity = 0.9 * lightLevel
  state.sun.intensity = 1.6 * lightLevel
}

function startAR() {
  if (params.has('debug')) setInterval(() => { if (state.world) setHint(`camera ${state.world.camera.position.y.toFixed(2)} m above surface · table ${onTable()}`) }, 500)
  const run = () => {
    // Absolute scale: the engine measures real metres, so plants keep their true size
    // on a floor and on a table. ?scale=responsive switches back to the guessed scale.
    XR8.XrController.configure({scale: params.get('scale') === 'responsive' ? 'responsive' : 'absolute', enableLighting: true})
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      XR8.CanvasScreenshot.pipelineModule(),
      LandingPage.pipelineModule(),
      XRExtras.FullWindowCanvas.pipelineModule(),
      XRExtras.Loading.pipelineModule(),
      XRExtras.RuntimeError.pipelineModule(),
      leafconModule(),
    ])
    XR8.run({canvas: $('camerafeed')})
  }
  window.XR8 ? run() : window.addEventListener('xrloaded', run, {once: true})
}

// ---------- Demo mode (no camera): a real office panorama with a floor ----------
// Office panorama: Poly Haven "Poly Haven Studio" (CC0), projected onto a ground plane.
const DEMO_EYE_HEIGHT = 1.6  // metres. Camera height of the panorama; sets the plant scale in the room.
function startPreview() {
  const canvas = $('camerafeed')
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true})
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xd9ddd6)
  const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 100)
  camera.position.set(0.8, DEMO_EYE_HEIGHT, 6)
  initScene({scene, camera, renderer})
  // Two scenes: company grounds (Poly Haven "Neuer Zollhof", a sealed office plaza) and an office.
  let sky = null
  const controls = new OrbitControls(camera, canvas)
  // The panorama looks right only near its own camera spot. A room needs a closer view.
  const VIEWS = {
    // sun: direction of the sun in the panorama (measured from env/grounds.jpg, raised a little).
    grounds: {pick: 'youngtree', sun: [0.711, 0.469, 0.524], shadow: 0.55, reach: 25, radius: 60, cam: [0.8, DEMO_EYE_HEIGHT, 6], target: [0, 1.4, -1], max: 14},
    office: {pick: 'ficus', sun: [0.3, 1, 0.4], shadow: 0.4, reach: 7, radius: 10, cam: [0.3, DEMO_EYE_HEIGHT, 2.6], target: [0, 1.1, -1], max: 4.5},
  }
  const texLoader = new THREE.TextureLoader()
  const loadScene = (name) => {
    state.demoReady = false
    texLoader.load(`env/${name}.jpg`, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping
      tex.colorSpace = THREE.SRGBColorSpace
      if (sky) { scene.remove(sky); sky.material.map?.dispose(); sky.geometry.dispose() }
      const v = VIEWS[name]
      document.querySelector(`#tray .item[data-id="${v.pick}"]`)?.click()
      sky = new GroundedSkybox(tex, DEMO_EYE_HEIGHT, v.radius)
      state.sunDir.set(...v.sun).normalize()
      floor.material.opacity = v.shadow
      state.maxPlace = v.reach
      camera.position.set(...v.cam); controls.target.set(...v.target); controls.maxDistance = v.max; controls.update()
      sky.position.y = DEMO_EYE_HEIGHT - 0.01
      scene.add(sky)
      scene.environment = tex
      scene.environmentIntensity = 0.8
      renderer.toneMapping = THREE.NoToneMapping  // the panorama is already tone-mapped
      state.demoReady = true
    })
    document.querySelectorAll('#scenes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === name)))
  }
  document.querySelectorAll('#scenes button').forEach((b) => b.addEventListener('click', () => loadScene(b.dataset.scene)))
  $('scenes').classList.remove('hidden')
  loadScene(params.get('scene') === 'office' ? 'office' : 'grounds')
  controls.enablePan = false
  controls.minDistance = 1.2
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86)
  // Capture phase runs before OrbitControls: no orbiting while a plant is dragged.
  canvas.addEventListener('pointerdown', (e) => { controls.enabled = !plantHitAt(e.clientX, e.clientY) }, true)
  canvas.addEventListener('pointerup', () => { controls.enabled = true })
  bindPointer(canvas)
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  }
  addEventListener('resize', resize)
  resize()
  renderer.setAnimationLoop((t) => { controls.update(); tick(performance.now()); renderer.render(scene, camera) })
  $('ui').classList.remove('hidden')
  window.__leafcon = {state, placeAt, THREE, controls}  // for automated tests
}

buildTray()
bindButtons()
$('go').addEventListener('click', () => {
  $('start').classList.add('hidden')
  PREVIEW ? startPreview() : startAR()
})
$('demo').addEventListener('click', () => {
  PREVIEW = true
  $('start').classList.add('hidden')
  startPreview()
})
if (PREVIEW) $('demo').classList.add('hidden')
