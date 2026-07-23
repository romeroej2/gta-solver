# GTA Fingerprint Solver

A **helper / companion tool** for the GTA Online fingerprint hacking
minigames. Open it on your phone, point the camera at your TV or monitor,
snap one photo, and it shows you the solution — like a smart, automatic
version of the community cheat-sheet images players already keep on a second
screen.

> **Not a cheat.** This app does not modify the game, inject code, read game
> memory, automate inputs, or interact with GTA Online in any way. It only
> looks at a photo you take of your own screen. You still play the minigame
> yourself.
>
> **Not affiliated with, endorsed, or sponsored by Rockstar Games or
> Take-Two Interactive.** Grand Theft Auto and all in-game imagery are
> trademarks/copyrights of their respective owners. This is an unofficial
> fan-made tool for personal use.

**Live app:** deployed on Vercel — open it in iOS Safari / Android Chrome and
allow camera access ("Add to Home Screen" recommended).

## Modes

### Casino (Diamond Casino Heist — fingerprint clone)

The puzzle with a big target fingerprint and 8 component squares (2×4 grid).
Fit the puzzle window in the on-screen guide, snap → the app identifies which
of the 4 known target prints it is and highlights exactly which 4 squares to
pick this run.

- A built-in answer sheet (in `src/assets/refs/`, sliced from a cheat-sheet
  image by `scripts/crop.ps1`) maps each of the game's 4 target prints to its
  4 correct component images.
- Matching uses HOG ridge-orientation descriptors — ridge *flow* survives
  photographing a screen (moiré, glare, thick glowing ridges, color tint)
  where raw pixel correlation fails.
- The print is chosen by combined evidence: greedy assignment of its 4
  reference components onto distinct squares + target-print similarity.
  A thin winner margin is flagged so you know to retake.

### Cayo (Cayo Perico Heist — slice alignment)

The puzzle with 8 horizontal fingerprint slices to scroll into place. One
snap → per row: `✓ correct`, `3 → right`, or `2 ← left`.

No answer sheet is needed — each row's slice is one of the 8 horizontal bands
of the target print, so the app matches rows against the print itself:

- The green game window is auto-detected in the photo (green-pixel density
  profiles), so screen size, distance, and framing barely matter.
- The print is isolated as the largest connected bright blob (immune to
  dot-grid panel backgrounds); the 8 bordered row slots are found by fitting
  a uniform grid to full-width border lines.
- Each slice is matched to a band by normalized correlation over small shifts
  and crop scales.

## Develop

```
npm install
npm run dev
```

`getUserMedia` requires HTTPS (or localhost). The 📷 photo button is a
fallback that uses the native camera app instead of the live viewfinder.

## Deploy

The repo is set up for Vercel: pushes to `main` auto-deploy (Vite is
auto-detected — build `npm run build`, output `dist/`). Manual deploy:

```
npx vercel --prod
```

## Notes

- All matching runs client-side in the browser — no backend, no images leave
  the phone.
- Game imagery (reference fingerprints) belongs to Rockstar Games /
  Take-Two Interactive; included only as a gameplay aid, the same material
  found in community-made cheat sheets. If you are a rights holder and want
  it removed, open an issue.
