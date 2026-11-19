# Video Upscaler (Chrome / Edge extension)

Upscales and sharpens videos you watch in the browser, in real time on your Mac's GPU.
Each video gets redrawn at your screen's full Retina resolution using a bicubic
(Catmull-Rom) upscale with anti-ringing, followed by AMD's contrast-adaptive sharpening (CAS).

## Install on Mac (takes about 1 minute)

1. Unzip `video-upscaler.zip` and put the `video-upscaler` folder somewhere permanent, such as Documents.
   Chrome loads the extension from that folder, so don't delete it.
2. In Chrome, go to `chrome://extensions` (in Edge, `edge://extensions`).
3. Turn on **Developer mode** (top-right in Chrome, left sidebar in Edge).
4. Click **Load unpacked** and select the `video-upscaler` folder.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Video Upscaler**.
6. Reload any tab that already has a video open.

## Use

- It turns on automatically for any video bigger than a thumbnail.
- Click the toolbar icon to:
  - turn it on or off
  - set **Sharpness** (0% = upscale only; 40–60% is a good range)
  - set **Max output resolution** (choose 1080p to save battery)
  - see the status for the current tab, e.g. `640×360 → 2560×1440`
- **Before/after:** press **Option + Shift + U** on the page to switch it on or off.

## Works on / doesn't work on

| Works | Doesn't work |
|---|---|
| YouTube, Twitch, Vimeo, Reddit, X/Twitter, most news and embedded players, local video files opened in the browser | Netflix, Disney+, Hulu, Max, Prime Video, Apple TV+, and other DRM-protected streams. Browsers block access to their frames, so the extension leaves them alone. |

If it says "WebGL2 unavailable", turn on Chrome Settings → System → **Use graphics acceleration when available**.

## Notes

- This is a fast, real-time filter, not AI super-resolution. It makes low-res video
  noticeably cleaner and crisper, but it can't invent detail that isn't there.
- If the screen already shows the video at or below its native resolution
  (for example, 4K video in a small window), the extension stays idle to save power.
- Clicks pass straight through, so the site's own player controls keep working.
