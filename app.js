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

const PLANTS = [
  {id: 'ficus', name: 'Ficus', size: '1.35 m'},
  {id: 'moneytree', name: 'Money tree', size: '2.3 m'},
  {id: 'syngonium', name: 'Syngonium', size: '0.85 m'},
  {id: 'planter', name: 'Planter', size: '1.3 m wide'},
  {id: 'raisedbed', name: 'Raised bed', size: '1 m'},
]
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
}

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
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -4; sun.shadow.camera.right = 4
  sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 12
  sun.shadow.bias = -0.0005
  sun.shadow.radius = 4
  scene.add(sun, sun.target)
  state.sun = sun

  // Invisible floor that only shows shadows. Used for tap raycasts.
  floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({opacity: 0.32}))
  floor.rotateX(-Math.PI / 2)
  floor.receiveShadow = true
  scene.add(floor)

  // Placement reticle: a ring on the floor where the centre of the screen points.
  reticle = new THREE.Group()
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.9}))
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
  if (hit.distance > 12) return null
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
  updateReticle()
  if (state.active) {
    selRing.position.set(state.active.root.position.x, 0.004, state.active.root.position.z)
  }
}

function updateReticle() {
  if (!state.world || !reticle) return
  const r = state.world.renderer.domElement.getBoundingClientRect()
  const p = floorHitAt(r.left + r.width / 2, r.top + r.height * 0.55)
  reticle.visible = !!p && !state.active
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
  const root = new THREE.Group()
  root.add(proto.clone(true))
  root.position.set(point.x, 0, point.z)
  // Face the plant's front to the viewer, with a little random turn so groups look natural.
  const cam = state.world.camera.position
  root.rotation.y = Math.atan2(cam.x - point.x, cam.z - point.z) + (Math.random() - 0.5) * 0.6
  root.scale.setScalar(0.01)
  const plant = {root, type}
  root.userData.plant = plant
  state.world.scene.add(root)
  state.placed.push(plant)
  animate(root, 0.01, 1, 650)
  updateCount()
  if (state.placed.length === 1) setHint('Nice. Drag a plant to move it. Tap it to rotate or remove.', false, 3500)
  else hideHint()
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

function updateCount() {
  const n = state.placed.length
  $('count').textContent = n === 1 ? '1 plant' : `${n} plants`
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
  for (const p of PLANTS) {
    const b = document.createElement('button')
    b.className = 'item'
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
  reticle.visible = false
  const flash = $('flash')
  flash.style.opacity = '0.9'
  setTimeout(() => { flash.style.opacity = '0' }, 120)
  try {
    let dataUrl
    if (PREVIEW) {
      const {renderer, scene, camera} = state.world
      renderer.render(scene, camera)
      dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.9)
    } else {
      const b64 = await XR8.CanvasScreenshot.takeScreenshot({onProcessFrame: ({ctx, canvas}) => stampBrand(ctx, canvas)})
      dataUrl = 'data:image/jpeg;base64,' + b64
    }
    lastPhotoBlob = await (await fetch(dataUrl)).blob()
    $('shot').src = dataUrl
    $('sheet').classList.remove('hidden')
  } catch (e) {
    setHint('Photo failed. Try again.', true, 2500)
  }
  if (wasActive) select(wasActive)
}

function stampBrand(ctx, canvas) {
  const s = canvas.width / 400
  ctx.save()
  ctx.fillStyle = 'rgba(255,255,255,.9)'
  const w = 170 * s, h = 34 * s, x = 12 * s, y = canvas.height - h - 12 * s
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill()
  ctx.fillStyle = '#2F7D4F'
  ctx.font = `700 ${16 * s}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText('LeafCon', x + 12 * s, y + h / 2)
  ctx.fillStyle = '#5B6B60'
  ctx.font = `500 ${10 * s}px "Instrument Sans", system-ui, sans-serif`
  ctx.fillText('air-con made of leaves', x + 80 * s, y + h / 2)
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
    onUpdate: () => tick(performance.now()),
  }
}

function startAR() {
  const run = () => {
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
  camera.position.set(0.4, DEMO_EYE_HEIGHT, 3.4)
  initScene({scene, camera, renderer})
  new THREE.TextureLoader().load('env/office.jpg', (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping
    tex.colorSpace = THREE.SRGBColorSpace
    const sky = new GroundedSkybox(tex, DEMO_EYE_HEIGHT, 30)
    sky.position.y = DEMO_EYE_HEIGHT - 0.01
    scene.add(sky)
    scene.environment = tex
    scene.environmentIntensity = 0.8
    renderer.toneMapping = THREE.NoToneMapping  // the panorama is already tone-mapped
    state.demoReady = true
  })
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0.7, 0)
  controls.enablePan = false
  controls.minDistance = 1.2
  controls.maxDistance = 7
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
  window.__leafcon = {state, placeAt, THREE}  // for automated tests
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
