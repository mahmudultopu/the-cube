# The Cube

A 3×3 puzzle cube you can play right in your browser. Scramble it, race the clock, and open the built-in solving guide whenever you get stuck.

**▶ Play now: [the-cube-game.vercel.app](https://the-cube-game.vercel.app)**

No download or sign-up needed. It works on phones, tablets and computers.

---

## Features

**Gameplay**
- Swipe any row or column to turn it, or drag around the cube to look at it from any angle
- A random scramble at the start of every game
- A timer that starts on your first move, plus a move counter
- Undo, a new scramble at any time, and a button to recenter the cube
- Your personal best time is saved on your device

**Solving guide**
- A 7-step beginner's method, from the white cross to the final corners
- Show it while you play, or hide it if you want to solve on your own
- Tap any move sequence in the guide to watch it played on your cube

**Feel**
- Glossy, rounded 3D cube with soft lighting and shadows
- Smooth turning, with layers that settle into place and a cube that glides after a flick
- Turning sounds (with a mute button) and gentle vibration on supported phones
- Confetti and a results card when you solve it, with a button to share your time

**Controls**

| Action | Touch / mouse | Keyboard |
| --- | --- | --- |
| Turn a layer | Swipe along a row or column | `U` `D` `R` `L` `F` `B` |
| Turn counter-clockwise | Swipe the other way | Hold `Shift` |
| Look around | Drag the empty space | – |
| Undo | Undo button | `Ctrl` + `Z` |
| Turn with buttons | Open **Moves** | – |

---

## How to solve the cube (overview)

The guide in the game explains each step in detail. In short:

1. **White cross:** make a white plus sign on top, with edge colors matching the centers.
2. **White corners:** fill in the white corners using `R U R' U'`.
3. **Middle layer:** insert the middle edges with `U R U' R' U' F' U F` or `U' L' U L U F U' F'`.
4. **Yellow cross:** make a yellow plus sign on top with `F R U R' U' F'`.
5. **Yellow edges:** line up the yellow edges with `R U R' U R U2 R' U`.
6. **Yellow corners in place:** move the corners into position with `U R U' L' U R' U' L`.
7. **Twist the last corners:** turn each corner with `R' D' R D` until the cube is solved.

---

## Built with

- HTML, CSS and plain JavaScript, with no frameworks and no build step
- [three.js](https://threejs.org/) for the 3D graphics

## Project structure

```
index.html                   Page layout and the solving guide
assets/css/style.css         Design, layout and animations
assets/js/game.js            Cube, controls, timer and game logic
assets/vendor/three.min.js   three.js library (MIT licence)
```

## Run it yourself

1. Download or clone this repository.
2. Open `index.html` in your browser.

To publish your own copy, upload the folder to any static hosting service, such as GitHub Pages, Vercel or Netlify.

---

Enjoy the puzzle, and see how fast you can solve it!
