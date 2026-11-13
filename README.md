# Wake Runner

A small top-down 3D speedboat game built with [Three.js](https://threejs.org/). It runs in the browser and is made for phones.

## Play

Once GitHub Pages is on, the game is at **https://suchlikesleet.github.io/TEST009/**.
On your phone, open the link and choose **Add to Home Screen**. It then opens fullscreen, like an app.

### Controls
| | Touch | Keyboard |
|---|---|---|
| Steer + throttle | Drag anywhere: the boat heads where the stick points, and pushing further makes it go faster | W/S or ↑/↓ for throttle, A/D or ←/→ to steer |
| Boost | Hold **BOOST** | Space or Shift |

Collect the gold rings. The yellow arrow points to the nearest one.

## Turning on GitHub Pages (one time)
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push a commit, or run the **Deploy to GitHub Pages** workflow from the Actions tab.

## Run locally
There's no build step, so any static file server works:
```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Code map
| File | What it does |
|---|---|
| `index.html`, `style.css` | Page, HUD, touch UI |
| `src/main.js` | Renderer, lights, camera follow, game loop |
| `src/boat.js` | Boat model and physics: thrust, drag, drift, turning, bank and pitch tilt, floating on waves |
| `src/water.js` | Wave shader; `waveHeight()` uses the same maths on the CPU so things float on the visible surface |
| `src/world.js` | Seeded islands, palms, buoys, collectible rings, collisions |
| `src/wake.js` | Foam trail behind the boat |
| `src/controls.js` | Floating touch joystick, boost button, keyboard |
| `vendor/three.module.min.js` | Three.js r169 (MIT), stored in the repo so the game works with no CDN |

To tune how the boat handles, change the constants at the top of `src/boat.js`.
