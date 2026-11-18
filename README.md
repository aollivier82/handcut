# Handcut

A video editor for Meta Quest 3 that you work with your bare hands. No controllers, no flat panels: recordings are pills on three tracks, and you cut one by chopping your hand through it.

## Using it in the headset

Everything you touch is within arm's reach; the screen is far away and cinema sized. The desk is built around where you are standing or sitting when you enter VR.

| You want to | Do this |
| --- | --- |
| Play or pause | Tap the orange button on the console (look down) |
| Move through the edit | Swipe the ribbed belt left or right with a fingertip, like a phone screen. A flick keeps it rolling. The film slides under the fixed amber line |
| Jump anywhere | Pinch the brass dial and slide it, or pinch a spot on its rail |
| Select a pill | Tap it with a fingertip (or pinch it) |
| Cut | Select a pill, slide the film until the line is where you want the cut, then chop your open hand down through the pill. Only the selected pill can be cut, and the cut always lands on the line |
| Trim | Pinch the mint (start) or amber (end) grip of a pill and stretch. The end you are not holding stays still. The grip turns red at the start or end of the recording |
| Move or reorder | Pinch a pill's body and carry it. A ghost shows where it will land; pills make room |
| Merge | Pinch one pill in each hand, hold them end to end for two seconds |
| Add a recording | Tap it on the library shelf (left), or pinch it and carry it to a track. Swipe the shelf up and down to scroll |
| Stack videos | Put pills on tracks 2 and 3. Where tracks overlap, the picture splits into bands, highest track on top |
| Everything else | The keys on the right: Undo, Redo, Split, Delete, Sound, 9:16 / 16:9, Import, Export, Recenter, Leave VR |
| Bring the desk closer | Pinch the brass bar at the front of the console and drag. It remembers |

**Import** leaves VR to open the headset's file picker (a browser rule), then takes you back. **Export** renders an MP4 on the device; **Save** leaves VR, where you can save the file and open TikTok's upload page.

## Run it

```sh
npm install
npm run build
npm run preview      # http://localhost:47841
```

On a Quest connected by USB: `adb reverse tcp:47841 tcp:47841`, then open `http://localhost:47841/` in the Quest browser. Any static HTTPS host works for a public link: upload `dist/`.

On a computer the same page works with a mouse: click to select, drag to move, drag the ends to trim, scroll to move through the edit, `S` or double-click to cut, `Space` to play.

## Checks

```sh
npm test                      # timeline rules (17 tests)
npm run dev -- --port 47842   # then, in another terminal:
node tools/run-sim.mjs        # simulated hands: press, tap, swipe, chop, trim, move, merge, library, dial
node tools/xr-check.mjs       # a full VR session on an emulated Quest 3 (IWER) with emulated hands
node tools/export-check.mjs   # exports four timelines and validates the files with ffprobe
```

## How it is built

- `src/model.js` — the timeline as pure functions. Pills that touch stay together: stretching pushes neighbours, shrinking pulls them, lifting one closes the hole.
- `src/editor.js` — commands, undo, autosave, live trim and carry gestures computed from the moment the grab began (a shaky hand cannot accumulate error).
- `src/hands.js` — WebXR hand joints through Meta's IWSDK input layer (`@iwsdk/xr-input`); pinch, fingertip, open-hand and edge-on detection; gloves drawn from the same joints.
- `src/interact.js` — what hands do: keys, taps, swipes, pinch grabs, the two-hand merge and the chop.
- `src/stage.js`, `src/ui3d.js` — the 3D workspace, built in code. `src/player.js` — preview playback. `src/export.js` — offline render with Mediabunny and WebCodecs.

Sample clips, sounds and every model are original and generated in code or with ffmpeg. Hand joint models: WebXR Input Profiles (MIT). Font: DM Sans (OFL).
