# Reframe

A local web app that turns a video into any shape: wide to 9:16 for Reels and Shorts, tall to 16:9, 4:5, 1:1, 4:3 or a custom ratio, several at once. The frame follows the person in the shot like a camera operator would. Add a look, upscale it (optionally with AI), and download it without losing quality.

Everything runs on your Mac. Videos never leave it, except when you choose the optional cloud upscaler.

## Run it

```sh
make setup   # once: installs ffmpeg + yt-dlp (Homebrew), the AI upscaler, tracking models, npm packages
make run     # builds and serves the app at http://localhost:8787
```

For development with hot reload use `make dev` and open http://localhost:5173. Run the tests with `make test`.

Optional: to use **AI upscale in the cloud**, copy `.env.example` to `.env`, add your `REPLICATE_API_TOKEN`, and restart. Topaz Video Upscale bills your Replicate account for each video.

## On your phone (iPhone and Android)

Reframe runs on the Mac; phones open it over [Tailscale](https://tailscale.com/download), which gives the Mac a private HTTPS address that only your own devices can reach. It works on Wi-Fi or mobile data.

1. Install Tailscale on the Mac and your phones, and sign in to the same account on each. On a work Mac, check with IT first.
2. With Reframe running (`make run`), run `make phone`. The first time, Tailscale may ask you to turn on HTTPS for your account; follow its link.
3. On the Mac, click **On your phone** on the home screen and scan the QR code. Then install it:
   - **iPhone:** tap Share, then Add to Home Screen.
   - **Android:** tap Install app.

On the phone, the editor puts the picture and timeline on top and the tools in tabs. Tap a person to follow them, drag the frame to steer, and use **Save to phone** on a finished render to save it to Photos or share it to Instagram. On Android, Reframe also shows up in the share sheet: share a video from Gallery, or a YouTube or Instagram link, straight into it.

The app is installable (a PWA) with a service worker that:
- keeps the app and the ~20 MB of tracking models on the phone, so it opens instantly;
- shows a clear message when the Mac can't be reached;
- delivers **notifications when a render finishes**. Turn them on in Export, then Renders, then Notify me. On iPhone this only works in the version added to the Home Screen.

Videos and renders always stay on the Mac. To stop sharing: `tailscale serve --https=443 off`.

## Using it

1. **Add a video.** Drop a file or paste a link (YouTube, Instagram, X, a direct `.mp4`; links are downloaded with yt-dlp). The app makes a light preview copy. Renders always use the original file.
2. **Pick shapes.** Toggle 9:16, 4:5, 1:1, 4:3, 3:4, 2:3, 16:9, 21:9, or add a custom W:H. Each shape keeps one color on the frame lines, its preview and its render.
3. **Framing for each shape:**
   - *Follow* moves the frame with the subject.
   - *Center* keeps it fixed.
   - *Fit all* keeps the whole picture over a blurred fill, which suits tall video going wide.
4. **Camera.** The first time you open a video, the app scans it for people (MediaPipe, in the browser) and for scene cuts.
   - Choose *One person* or *Everyone*, and how steady the movement is.
   - **Pause and click a person** to follow them for the rest of that shot.
   - **Drag the frame** to fix a moment. Drag it **while playing** to steer live.
   - The timeline shows where the frame sits, the stretches you steered by hand, and the cuts. At a cut the frame jumps instead of panning.
   - Drag the handles at either end of the timeline to export only part of the video.
5. **Look.** Presets (Vivid, Golden, Cool, Film, Moody, Airy, Mono) and sliders for brightness, contrast, saturation, warmth, tint, fade, vignette and sharpening. Hold *Hold for original* to compare.
6. **Export.**
   - **Size:** *Original pixels* keeps exactly the source pixels in the frame. 1080p, 1440p and 4K resize to a standard size.
   - **Enhance:**
     - *None* resizes with Lanczos.
     - *Clean up and sharpen* is a quick denoise and sharpen.
     - *AI upscale on this Mac* uses Real-ESRGAN on the GPU, is free, and shows a time estimate before you start.
     - *AI upscale in the cloud* uses Topaz on Replicate.
   - **Check a frame** renders the current frame exactly as the export will, with a before/after slider at actual pixels.
   - **File:**
     - *MP4* is H.264 at CRF 14, visually lossless and plays everywhere. 10-bit/HDR sources get HEVC 10-bit with HDR kept.
     - *ProRes 422 HQ* is for editing.
     - *Lossless FFV1* (.mkv) changes no pixel in compression. With *Original pixels*, no enhancer and no look, every pixel is identical to the source.

Finished files download from the Renders tab and are also kept in `data/renders/`.

## How it works

- `frontend/` (React, TypeScript, Vite, Zustand, React Query)
  - The browser scans the preview copy for people, faces and cuts.
  - It turns those detections into a smooth camera path: it holds onto one subject, ignores jitter, eases moves both ways so the camera neither lags nor leads, and never pans across a cut.
  - It previews the shapes and the look live. The look is one color matrix, applied in the preview with an SVG `feColorMatrix`.
- `backend/` (Go: the standard library plus webpush-go for notifications)
  - Imports, makes the preview copy and queues renders.
  - Drives ffmpeg: the camera path becomes per-frame `sendcmd` crop moves, and the look matrix goes through `colorchannelmixer`, done in 16-bit RGB with the source's color matrix so colors don't shift.
  - For local AI, frames stream through Real-ESRGAN in batches of 24, so temp disk use stays small however long the video is.
- The crop math exists in both Go and TypeScript, so the frame you see is the frame you get. Both test suites check the same numbers.

## Limits worth knowing

- **Phones:**
  - Tested in Chrome with an emulated phone and in Safari's engine (WebKit) with iPhone emulation, but not yet on a real iPhone or Android.
  - Notifications were tested up to the push service: Google accepted them, and a test decrypts the payload the way a phone does. Actual delivery to a phone hasn't been seen yet.
  - The people scan runs in the phone's browser the first time you open a new video, and is slower there; open it on the Mac first if you like.

- **Local AI speed:** about 0.6 s per 608×1080 frame on an M2 Pro (realesr-general-x4v3, via Upscayl's ncnn build). A 30 s 9:16 crop of 1080p video takes around 9 minutes. The export panel estimates it first.
- **Cloud enhance** is implemented, but it hasn't been run end to end because it needs a paid token.
- **HDR:** the preview copy isn't tone-mapped, so HDR clips look flat in the editor. MP4 exports keep HDR. AI-upscaled exports are 8-bit SDR.
- **Tracking:**
  - The scan samples 6 times a second (4 for videos over 3 minutes), so very fast whip-pans can trail by a moment. Steer those by hand.
  - The face model is short-range. Distant people are tracked by their body.
  - With nobody in the shot, it falls back to animals and vehicles, then the center.
- Videos with non-square pixels (anamorphic SAR) are treated as square.
